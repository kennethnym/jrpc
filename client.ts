import { getDispatcher } from "./transport"
import type { JrpcChannel, JsonRpcTransport } from "./transport"

type JsonRpcHandler = (...params: any[]) => any
type JsonRpcMethod<Schema> = Extract<keyof Schema, string>

export class JsonRpcClient<Schema extends Record<keyof Schema, JsonRpcHandler>> {
	private dispatcher: JsonRpcTransport

	constructor(channel: JrpcChannel) {
		this.dispatcher = getDispatcher(channel)
	}

	async call<M extends JsonRpcMethod<Schema>>(
		method: M,
		...params: Parameters<Schema[M]>
	): Promise<Awaited<ReturnType<Schema[M]>>> {
		return this.dispatcher.call(method, params) as Promise<Awaited<ReturnType<Schema[M]>>>
	}
}
