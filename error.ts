export const JsonRpcErrorCode = {
	ParseError: -32700,
	InvalidRequest: -32600,
	MethodNotFound: -32601,
	InvalidParams: -32602,
	InternalError: -32603,
	ServerError: -32000,
} as const

export type JsonRpcErrorCode = (typeof JsonRpcErrorCode)[keyof typeof JsonRpcErrorCode]

export interface JsonRpcErrorObject {
	code: number
	message: string
	data?: unknown
}

export class JsonRpcRemoteError extends Error {
	code: number
	data?: unknown

	constructor(error: JsonRpcErrorObject) {
		super(error.message)
		this.name = "JsonRpcRemoteError"
		this.code = error.code
		this.data = error.data
	}
}

export function toJsonRpcError(error: unknown): JsonRpcErrorObject {
	if (error instanceof Error) {
		return {
			code: JsonRpcErrorCode.ServerError,
			message: error.message,
		}
	}

	return {
		code: JsonRpcErrorCode.ServerError,
		message: String(error),
	}
}
