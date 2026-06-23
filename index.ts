import { JsonRpcErrorCode as JsonRpcErrorCodes } from "./error"
import type { JsonRpcErrorCode as JsonRpcErrorCodeValue } from "./error"

export { JsonRpcClient } from "./client"
export { JsonRpcRemoteError } from "./error"
export { JsonRpcServer } from "./server"
export {
	deserializeJrpcMessage,
	isJrpcMessage,
	isJsonRpcErrorResponse,
	isJsonRpcRequest,
	isJsonRpcResponse,
	isJsonRpcSuccessResponse,
} from "./transport"
export const JsonRpcErrorCode = JsonRpcErrorCodes
export type JsonRpcErrorCode = JsonRpcErrorCodeValue
export type { JsonRpcErrorObject } from "./error"
export type {
	JrpcChannel,
	JrpcMessage,
	JsonRpcErrorResponse,
	JsonRpcMessage,
	JsonRpcRequest,
	JsonRpcResponse,
	JsonRpcSuccessResponse,
	JsonRpcTransport,
} from "./transport"

export interface TestSchema {
	sendMessage(content: string): void
	test(a: number, b: string): void
}
