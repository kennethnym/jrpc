import { expect, test } from "bun:test"
import { JsonRpcClient, JsonRpcErrorCode, JsonRpcRemoteError, JsonRpcServer } from "../index.ts"
import type { JrpcChannel, JrpcMessage, JsonRpcMessage } from "../transport.ts"

type NextResult = IteratorResult<JrpcMessage, void>
type Waiter = {
	reject(reason: unknown): void
	resolve(result: NextResult): void
}

class MemoryChannel implements JrpcChannel {
	private closed = false
	private failure?: unknown
	private peer?: MemoryChannel
	private queue: JrpcMessage[] = []
	private waiters: Waiter[] = []

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

	async receive(): Promise<JrpcMessage> {
		const result = await this.next()

		if (result.done) {
			throw new Error("MemoryChannel closed before receiving a message.")
		}

		return result.value
	}

	async next(..._args: [] | [unknown]): Promise<NextResult> {
		if (this.failure) {
			throw this.failure
		}

		const msg = this.queue.shift()

		if (msg) {
			return {
				done: false,
				value: msg,
			}
		}

		if (this.closed) {
			return {
				done: true,
				value: undefined,
			}
		}

		return new Promise<NextResult>((resolve, reject) => {
			this.waiters.push({ reject, resolve })
		})
	}

	async return(_value?: void): Promise<NextResult> {
		this.close()

		return {
			done: true,
			value: undefined,
		}
	}

	async throw(error?: unknown): Promise<NextResult> {
		this.fail(error)

		throw error
	}

	close(): void {
		if (this.closed) {
			return
		}

		this.closed = true

		for (const waiter of this.waiters.splice(0)) {
			waiter.resolve({
				done: true,
				value: undefined,
			})
		}
	}

	fail(error: unknown): void {
		this.failure = error

		for (const waiter of this.waiters.splice(0)) {
			waiter.reject(error)
		}
	}

	[Symbol.asyncIterator](): AsyncGenerator<JrpcMessage, void, unknown> {
		return this
	}

	async [Symbol.asyncDispose](): Promise<void> {
		this.close()
	}

	private push(msg: JrpcMessage): void {
		const waiter = this.waiters.shift()

		if (waiter) {
			waiter.resolve({
				done: false,
				value: msg,
			})
			return
		}

		this.queue.push(msg)
	}
}

function createChannelPair(): [MemoryChannel, MemoryChannel] {
	const left = new MemoryChannel()
	const right = new MemoryChannel()

	left.link(right)
	right.link(left)

	return [left, right]
}

async function closeChannelPair(
	left: MemoryChannel,
	right: MemoryChannel,
	...running: Promise<unknown>[]
): Promise<void> {
	left.close()
	right.close()

	await Promise.allSettled(running)
}

async function resolveWithin<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined

	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timeout = setTimeout(
					() => reject(new Error("Timed out waiting for JSON-RPC response.")),
					ms,
				)
			}),
		])
	} finally {
		if (timeout) {
			clearTimeout(timeout)
		}
	}
}

interface EndpointAApi {
	describe(name: string): string
}

interface ReentrantEndpointAApi {
	inner(value: string): Promise<string>
}

interface ReentrantEndpointBApi {
	finish(value: string): string
	outer(value: string): Promise<string>
}

interface MathApi {
	add(a: number, b: number): number
	ping(): string
}

interface FailingApi {
	add(a: number, b: number): number
	fail(): string
	ping(): string
}

test("clients call real server handlers in both directions over shared endpoint channels", async () => {
	const [aChannel, bChannel] = createChannelPair()
	const addCalls: Array<[number, number]> = []
	const describeCalls: string[] = []

	const clientA = new JsonRpcClient<MathApi>(aChannel)
	const serverA = new JsonRpcServer<EndpointAApi>(
		{
			describe(name) {
				describeCalls.push(name)

				return `endpoint-a:${name}`
			},
		},
		aChannel,
	)

	const clientB = new JsonRpcClient<EndpointAApi>(bChannel)
	const serverB = new JsonRpcServer<MathApi>(
		{
			add(a, b) {
				addCalls.push([a, b])

				return a + b
			},
			ping() {
				return "pong"
			},
		},
		bChannel,
	)

	const runningA = serverA.start()
	const runningB = serverB.start()

	try {
		const [sum, description] = await Promise.all([
			clientA.call("add", 2, 3),
			clientB.call("describe", "Ada"),
		])

		expect(sum).toBe(5)
		expect(addCalls).toEqual([[2, 3]])
		expect(description).toBe("endpoint-a:Ada")
		expect(describeCalls).toEqual(["Ada"])

		expect(await clientA.call("ping")).toBe("pong")
	} finally {
		await closeChannelPair(aChannel, bChannel, runningA, runningB)
	}
})

test("request handlers can make re-entrant calls over the same channel", async () => {
	const [aChannel, bChannel] = createChannelPair()
	const clientA = new JsonRpcClient<ReentrantEndpointBApi>(aChannel)
	const serverA = new JsonRpcServer<ReentrantEndpointAApi>(
		{
			async inner(value) {
				const finished = await clientA.call("finish", value)

				return `inner:${finished}`
			},
		},
		aChannel,
	)
	const clientB = new JsonRpcClient<ReentrantEndpointAApi>(bChannel)
	const serverB = new JsonRpcServer<ReentrantEndpointBApi>(
		{
			finish(value) {
				return `finish:${value}`
			},
			async outer(value) {
				const inner = await clientB.call("inner", value)

				return `outer:${inner}`
			},
		},
		bChannel,
	)

	const runningA = serverA.start()
	const runningB = serverB.start()
	const result = clientA.call("outer", "Ada")

	try {
		expect(await resolveWithin(result, 1000)).toBe("outer:inner:finish:Ada")
	} finally {
		await closeChannelPair(aChannel, bChannel, runningA, runningB)
		await result.catch(() => undefined)
	}
})

test("client receives remote errors from real throwing server handlers", async () => {
	const [clientChannel, serverChannel] = createChannelPair()
	const client = new JsonRpcClient<FailingApi>(clientChannel)
	const server = new JsonRpcServer<FailingApi>(
		{
			add(a, b) {
				return a + b
			},
			fail() {
				throw new Error("handler failed")
			},
			ping() {
				return "pong"
			},
		},
		serverChannel,
	)
	const running = server.start()

	try {
		let error: unknown

		try {
			await client.call("fail")
		} catch (caught) {
			error = caught
		}

		expect(error).toBeInstanceOf(JsonRpcRemoteError)
	} finally {
		await closeChannelPair(clientChannel, serverChannel, running)
	}
})

test("server registration protects the dispatcher's single request handler per channel", () => {
	const [channel, peer] = createChannelPair()

	new JsonRpcServer({ ping: () => "pong" }, channel)

	expect(() => new JsonRpcServer({ duplicate: () => null }, channel)).toThrow(
		"JSON-RPC channel already has a request handler.",
	)

	channel.close()
	peer.close()
})

test("server handles protocol edge cases through real channel messages", async () => {
	const [rawClient, rawServer] = createChannelPair()
	const server = new JsonRpcServer(
		{
			ping() {
				return "pong-without-params"
			},
		},
		rawServer,
	)
	const running = server.start()

	try {
		await rawClient.send({
			jsonrpc: "2.0",
			id: 1,
			method: "ping",
		})
		expect(await rawClient.receive()).toEqual({
			jsonrpc: "2.0",
			id: 1,
			result: "pong-without-params",
		})

		await rawClient.send({
			jsonrpc: "2.0",
			id: 2,
			method: "toString",
			params: [],
		})
		expect(await rawClient.receive()).toMatchObject({
			error: {
				code: JsonRpcErrorCode.MethodNotFound,
			},
			id: 2,
			jsonrpc: "2.0",
		})

		await rawClient.send({
			jsonrpc: "2.0",
			id: 3,
			method: "ping",
			params: { named: true } as unknown as unknown[],
		})
		expect(await rawClient.receive()).toMatchObject({
			error: {
				code: JsonRpcErrorCode.InvalidParams,
				message: "Params must be an array.",
			},
			id: 3,
			jsonrpc: "2.0",
		})
	} finally {
		await closeChannelPair(rawClient, rawServer, running)
	}
})
