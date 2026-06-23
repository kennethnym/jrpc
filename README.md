# @nym.sh/jrpc

Typed JSON-RPC 2.0 over async channels.

`@nym.sh/jrpc` gives you a small client/server pair that works with any transport you can model as an async message stream plus a `send()` method. The transport could be a WebSocket, worker message port, IPC pipe, in-memory test channel, or something custom.

## Install

```bash
bun add @nym.sh/jrpc
```

```bash
npm install @nym.sh/jrpc
```

## Quick Start

Define the API as a TypeScript interface, create a server with matching handlers, and call it with a typed client.

```ts
import { JsonRpcClient, JsonRpcServer } from "@nym.sh/jrpc"
import type { JrpcChannel } from "@nym.sh/jrpc"

interface CalculatorApi {
	add(a: number, b: number): number
	hello(name: string): Promise<string>
}

declare const clientChannel: JrpcChannel
declare const serverChannel: JrpcChannel

const server = new JsonRpcServer<CalculatorApi>(
	{
		add(a, b) {
			return a + b
		},
		async hello(name) {
			return `Hello, ${name}.`
		},
	},
	serverChannel,
)

void server.start()

const client = new JsonRpcClient<CalculatorApi>(clientChannel)

const sum = await client.call("add", 2, 3)
const greeting = await client.call("hello", "Ada")

console.log(sum) // 5
console.log(greeting) // Hello, Ada.
```

`client.call()` is fully typed from the schema:

```ts
await client.call("add", 2, 3) // Promise<number>
await client.call("hello", "Ada") // Promise<string>

// TypeScript errors:
await client.call("missing")
await client.call("add", "2", "3")
```

## Channels

A channel is an async generator of JSON-RPC messages with a `send()` method:

```ts
import type { JrpcMessage, JsonRpcMessage } from "@nym.sh/jrpc"

interface JrpcChannel extends AsyncGenerator<JrpcMessage, void, unknown> {
	send(msg: JsonRpcMessage): Promise<void>
}
```

Each endpoint gets its own channel. Calling `send()` on one endpoint should deliver the message to the other endpoint's async iterator.

For raw JSON transports, parse incoming payloads with `deserializeJrpcMessage()` instead of casting `JSON.parse()` yourself:

```ts
import { deserializeJrpcMessage } from "@nym.sh/jrpc"

const msg = deserializeJrpcMessage(event.data)

if (!msg) {
	return
}
```

The package also exports `isJrpcMessage()`, `isJsonRpcRequest()`, `isJsonRpcResponse()`, `isJsonRpcSuccessResponse()`, and `isJsonRpcErrorResponse()` when a channel adapter needs to validate or narrow an unknown value.

Here is a minimal in-memory channel pair that is useful for tests and examples:

```ts
import type { JrpcChannel, JrpcMessage, JsonRpcMessage } from "@nym.sh/jrpc"

class MemoryChannel implements JrpcChannel {
	private closed = false
	private peer?: MemoryChannel
	private queue: JrpcMessage[] = []
	private waiters: Array<(result: IteratorResult<JrpcMessage, void>) => void> = []

	link(peer: MemoryChannel): this {
		this.peer = peer
		return this
	}

	async send(msg: JsonRpcMessage): Promise<void> {
		if (!this.peer) {
			throw new Error("MemoryChannel is not linked.")
		}

		this.peer.push(msg)
	}

	async next(): Promise<IteratorResult<JrpcMessage, void>> {
		const msg = this.queue.shift()

		if (msg) {
			return { done: false, value: msg }
		}

		if (this.closed) {
			return { done: true, value: undefined }
		}

		return new Promise((resolve) => {
			this.waiters.push(resolve)
		})
	}

	async return(): Promise<IteratorResult<JrpcMessage, void>> {
		this.close()
		return { done: true, value: undefined }
	}

	async throw(error?: unknown): Promise<IteratorResult<JrpcMessage, void>> {
		this.close()
		throw error
	}

	close(): void {
		this.closed = true

		for (const resolve of this.waiters.splice(0)) {
			resolve({ done: true, value: undefined })
		}
	}

	[Symbol.asyncIterator](): AsyncGenerator<JrpcMessage, void, unknown> {
		return this
	}

	private push(msg: JrpcMessage): void {
		const resolve = this.waiters.shift()

		if (resolve) {
			resolve({ done: false, value: msg })
			return
		}

		this.queue.push(msg)
	}
}

export function createMemoryChannelPair(): [MemoryChannel, MemoryChannel] {
	const left = new MemoryChannel()
	const right = new MemoryChannel()

	left.link(right)
	right.link(left)

	return [left, right]
}
```

## Bidirectional RPC

The same endpoint channel can have both a client and a server. This lets peers call each other, including re-entrant calls made from inside handlers.

```ts
import { JsonRpcClient, JsonRpcServer } from "@nym.sh/jrpc"

interface AppApi {
	formatName(name: string): string
}

interface PluginApi {
	describe(name: string): Promise<string>
}

const [appChannel, pluginChannel] = createMemoryChannelPair()

const appClient = new JsonRpcClient<PluginApi>(appChannel)
const pluginClient = new JsonRpcClient<AppApi>(pluginChannel)

const appServer = new JsonRpcServer<AppApi>(
	{
		formatName(name) {
			return name.toUpperCase()
		},
	},
	appChannel,
)

const pluginServer = new JsonRpcServer<PluginApi>(
	{
		async describe(name) {
			const formatted = await pluginClient.call("formatName", name)
			return `Plugin received ${formatted}`
		},
	},
	pluginChannel,
)

void appServer.start()
void pluginServer.start()

console.log(await appClient.call("describe", "Ada"))
// Plugin received ADA
```

Only one `JsonRpcServer` request handler can be registered per channel, but you can create multiple typed clients over the same channel if that helps organize local call sites.

## Remote Errors

If a server handler throws, the client receives a `JsonRpcRemoteError`.

```ts
import { JsonRpcRemoteError } from "@nym.sh/jrpc"

try {
	await client.call("dangerousOperation")
} catch (error) {
	if (error instanceof JsonRpcRemoteError) {
		console.error(error.code, error.message, error.data)
	}
}
```

Built-in JSON-RPC error codes are exported as `JsonRpcErrorCode`:

```ts
import { JsonRpcErrorCode } from "@nym.sh/jrpc"

console.log(JsonRpcErrorCode.MethodNotFound) // -32601
console.log(JsonRpcErrorCode.InvalidParams) // -32602
```

## API

### `new JsonRpcClient<Schema>(channel)`

Creates a typed client for calling methods exposed by the remote endpoint.

```ts
const client = new JsonRpcClient<MyApi>(channel)
const result = await client.call("methodName", arg1, arg2)
```

Arguments are sent as positional JSON-RPC params.

### `new JsonRpcServer<Schema>(handlers, channel)`

Registers handlers for requests received on the channel.

```ts
const server = new JsonRpcServer<MyApi>({ methodName() {} }, channel)
void server.start()
```

`start()` listens until the channel closes. Handler return values are sent as JSON-RPC results. `undefined` is serialized as `null`.

## Development

```bash
bun install
bun test
bun run typecheck
bun run build
```
