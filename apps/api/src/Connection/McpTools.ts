import * as Schema from "effect/Schema"

export const McpToolDescriptor = Schema.Struct({
	name: Schema.String,
	description: Schema.String,
	inputSchema: Schema.JsonObject,
	outputSchema: Schema.optionalKey(Schema.JsonObject),
})
export type McpToolDescriptor = typeof McpToolDescriptor.Type

export const McpToolDescriptors = Schema.Array(McpToolDescriptor)

export type McpContent =
	| { readonly type: "text"; readonly text: string }
	| { readonly type: "image"; readonly data: string; readonly mimeType: string }

export type McpFailureReason =
	| "credential_unavailable"
	| "wrong_server"
	| "unauthorized"
	| "forbidden"
	| "failed"

export interface McpFailure {
	readonly ok: false
	readonly reason: McpFailureReason
	readonly message: string
}

export type McpListOutcome =
	| { readonly ok: true; readonly tools: ReadonlyArray<McpToolDescriptor> }
	| McpFailure

export type McpCallOutcome =
	| {
			readonly ok: true
			readonly content: ReadonlyArray<McpContent>
			readonly structuredContent?: unknown
			readonly isError: boolean
	  }
	| McpFailure

/** One HTTP request a session's MCP client asks a connection to send for it. */
export interface ForwardRequest {
	readonly method: string
	readonly url: string
	readonly headers: ReadonlyArray<readonly [string, string]>
	readonly body: string | null
}

/** The answer, with the connection's secret removed, or why there is none. */
export type ForwardOutcome =
	| {
			readonly ok: true
			readonly status: number
			readonly headers: ReadonlyArray<readonly [string, string]>
			readonly body: string
	  }
	| McpFailure

/** Where a connection may send requests, and the secret it sends there, if it has one. */
export interface McpTarget {
	readonly url: string
	readonly token: (() => string | null) | null
}
