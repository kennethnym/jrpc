import { JsonRpcErrorCode, toJsonRpcError } from "./error"
import { getDispatcher } from "./transport"
import type { JrpcChannel, JsonRpcRequest, JsonRpcTransport } from "./transport"

type JsonRpcHandler = (...params: any[]) => any

export class JsonRpcServer<Schema extends Record<keyof Schema, JsonRpcHandler>> {
	private dispatcher: JsonRpcTransport

	constructor(
		private handlers: Schema,
		channel: JrpcChannel,
	) {
		this.dispatcher = getDispatcher(channel)
		this.dispatcher.setRequestHandler((msg) => this.handle(msg))
	}

	start(): Promise<void> {
		return this.dispatcher.start()
	}

	private async handle(msg: JsonRpcRequest): Promise<void> {
		if (!Object.hasOwn(this.handlers, msg.method)) {
			await this.dispatcher.send({
				jsonrpc: "2.0",
				id: msg.id,
				error: {
					code: JsonRpcErrorCode.MethodNotFound,
					message: `Method not found: ${msg.method}`,
				},
			})
			return
		}

		const handler = this.handlers[msg.method as keyof Schema] as JsonRpcHandler
		const params = msg.params ?? []

		if (!Array.isArray(params)) {
			await this.dispatcher.send({
				jsonrpc: "2.0",
				id: msg.id,
				error: {
					code: JsonRpcErrorCode.InvalidParams,
					message: "Params must be an array.",
				},
			})
			return
		}

		try {
			const result = await handler(...params)

			await this.dispatcher.send({
				jsonrpc: "2.0",
				id: msg.id,
				result: result ?? null,
			})
		} catch (error) {
			await this.dispatcher.send({
				jsonrpc: "2.0",
				id: msg.id,
				error: toJsonRpcError(error),
			})
		}
	}
}
