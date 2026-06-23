import { JsonRpcErrorCode, JsonRpcRemoteError } from "./error"
import type { JsonRpcErrorObject } from "./error"

export interface JsonRpcRequest {
	jsonrpc: "2.0"
	id: number
	method: string
	params?: unknown
}

export interface JsonRpcSuccessResponse {
	jsonrpc: "2.0"
	id: number
	result: unknown
}

export interface JsonRpcErrorResponse {
	jsonrpc: "2.0"
	id: number
	error: JsonRpcErrorObject
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse
export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse
export type JrpcMessage = JsonRpcMessage

export interface JrpcChannel extends AsyncGenerator<JrpcMessage, void, unknown> {
	send(msg: JsonRpcMessage): Promise<void>
}

export type RequestHandler = (msg: JsonRpcRequest) => Promise<void>

export interface JsonRpcTransport {
	call(method: string, params: unknown[]): Promise<unknown>
	send(msg: JsonRpcMessage): Promise<void>
	setRequestHandler(handler: RequestHandler): void
	start(): Promise<void>
}

interface PendingCall {
	resolve(value: unknown): void
	reject(reason: unknown): void
}

const dispatchers = new WeakMap<JrpcChannel, JsonRpcDispatcher>()

class JsonRpcDispatcher implements JsonRpcTransport {
	private activeRequests = new Set<Promise<void>>()
	private fatalHandlerError?: unknown
	private hasFatalHandlerError = false
	private unresolvedIds = new Set<number>()
	private pending = new Map<number, PendingCall>()
	private requestHandler?: RequestHandler
	private running?: Promise<void>
	private isClosed = false
	private closeReason: unknown

	constructor(private channel: JrpcChannel) {}

	setRequestHandler(handler: RequestHandler): void {
		if (this.requestHandler) {
			throw new Error("JSON-RPC channel already has a request handler.")
		}

		this.requestHandler = handler
	}

	send(msg: JsonRpcMessage): Promise<void> {
		return this.channel.send(msg)
	}

	start(): Promise<void> {
		if (!this.running) {
			this.running = this.listen()
			this.running.catch(() => undefined)
		}

		return this.running
	}

	async call(method: string, params: unknown[]): Promise<unknown> {
		if (this.isClosed) {
			throw this.closeReason
		}

		const id = this.createId()
		const response = new Promise<unknown>((resolve, reject) => {
			this.pending.set(id, {
				resolve,
				reject,
			})
		})

		this.start()

		try {
			await this.channel.send({
				jsonrpc: "2.0",
				id,
				method,
				params,
			})
		} catch (error) {
			this.pending.delete(id)
			this.unresolvedIds.delete(id)
			throw error
		}

		return response
	}

	private createId(): number {
		let id: number

		do {
			id = randomJsonRpcId()
		} while (this.unresolvedIds.has(id))

		this.unresolvedIds.add(id)

		return id
	}

	private async listen(): Promise<void> {
		let listenerError: unknown
		let hasListenerError = false

		try {
			for await (const msg of this.channel) {
				if (isJsonRpcRequest(msg)) {
					this.handleRequestInBackground(msg)
					continue
				}

				if (isJsonRpcResponse(msg)) {
					this.handleResponse(msg)
				}
			}
		} catch (error) {
			hasListenerError = true
			listenerError = error
			this.close(error)
		} finally {
			this.close(new Error("JSON-RPC channel closed."))
			await this.waitForActiveRequests()
		}

		if (hasListenerError) {
			throw listenerError
		}

		if (this.hasFatalHandlerError) {
			throw this.fatalHandlerError
		}
	}

	private handleRequestInBackground(msg: JsonRpcRequest): void {
		const request = this.handleRequest(msg)

		this.activeRequests.add(request)

		void request
			.catch((error) => {
				this.hasFatalHandlerError = true
				this.fatalHandlerError = error
				this.close(error)
				void this.channel.return(undefined).catch(() => undefined)
			})
			.finally(() => {
				this.activeRequests.delete(request)
			})
	}

	private async waitForActiveRequests(): Promise<void> {
		while (this.activeRequests.size > 0) {
			await Promise.allSettled(this.activeRequests)
		}
	}

	private handleResponse(msg: JsonRpcResponse): void {
		const pending = this.pending.get(msg.id)

		if (!pending) {
			return
		}

		this.pending.delete(msg.id)
		this.unresolvedIds.delete(msg.id)

		if (isJsonRpcErrorResponse(msg)) {
			pending.reject(new JsonRpcRemoteError(msg.error))
			return
		}

		pending.resolve(msg.result)
	}

	private async handleRequest(msg: JsonRpcRequest): Promise<void> {
		if (this.requestHandler) {
			await this.requestHandler(msg)
			return
		}

		await this.channel.send({
			jsonrpc: "2.0",
			id: msg.id,
			error: {
				code: JsonRpcErrorCode.MethodNotFound,
				message: `Method not found: ${msg.method}`,
			},
		})
	}

	private close(reason: unknown): void {
		if (this.isClosed) {
			return
		}

		this.isClosed = true
		this.closeReason = reason

		for (const pending of this.pending.values()) {
			pending.reject(reason)
		}

		this.pending.clear()
		this.unresolvedIds.clear()
	}
}

export function getDispatcher(channel: JrpcChannel): JsonRpcTransport {
	let dispatcher = dispatchers.get(channel)

	if (!dispatcher) {
		dispatcher = new JsonRpcDispatcher(channel)
		dispatchers.set(channel, dispatcher)
	}

	return dispatcher
}

export function deserializeJrpcMessage(value: string): JrpcMessage | null {
	let parsed: unknown

	try {
		parsed = JSON.parse(value)
	} catch {
		return null
	}

	if (!isJrpcMessage(parsed)) {
		return null
	}

	return parsed
}

export function isJrpcMessage(value: unknown): value is JrpcMessage {
	return isJsonRpcRequest(value) || isJsonRpcResponse(value)
}

export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
	if (!isJsonRpcObject(value)) {
		return false
	}

	if (value.jsonrpc !== "2.0") {
		return false
	}

	if (!isJsonRpcId(value.id)) {
		return false
	}

	if (typeof value.method !== "string") {
		return false
	}

	if (Object.hasOwn(value, "result") || Object.hasOwn(value, "error")) {
		return false
	}

	return true
}

export function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
	return isJsonRpcSuccessResponse(value) || isJsonRpcErrorResponse(value)
}

export function isJsonRpcSuccessResponse(value: unknown): value is JsonRpcSuccessResponse {
	if (!isJsonRpcObject(value)) {
		return false
	}

	return (
		value.jsonrpc === "2.0" &&
		isJsonRpcId(value.id) &&
		Object.hasOwn(value, "result") &&
		!Object.hasOwn(value, "error") &&
		!Object.hasOwn(value, "method")
	)
}

export function isJsonRpcErrorResponse(value: unknown): value is JsonRpcErrorResponse {
	if (!isJsonRpcObject(value)) {
		return false
	}

	return (
		value.jsonrpc === "2.0" &&
		isJsonRpcId(value.id) &&
		isJsonRpcErrorObject(value.error) &&
		!Object.hasOwn(value, "result") &&
		!Object.hasOwn(value, "method")
	)
}

function randomJsonRpcId(): number {
	const [id = 0] = crypto.getRandomValues(new Uint32Array(1))

	return id
}

function isJsonRpcObject(value: unknown): value is Record<PropertyKey, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isJsonRpcId(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value)
}

function isJsonRpcErrorObject(value: unknown): value is JsonRpcErrorObject {
	if (!isJsonRpcObject(value)) {
		return false
	}

	return Number.isFinite(value.code) && typeof value.message === "string"
}
