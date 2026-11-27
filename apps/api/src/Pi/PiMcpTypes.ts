import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

export const McpToolDescriptor = Schema.Struct({
	name: Schema.String,
	description: Schema.String,
	inputSchema: Schema.JsonObject,
	outputSchema: Schema.optionalKey(Schema.JsonObject),
	annotations: Schema.optionalKey(
		Schema.Struct({ readOnlyHint: Schema.optionalKey(Schema.Boolean) }),
	),
})
export type McpToolDescriptor = typeof McpToolDescriptor.Type

export const McpToolDescriptors = Schema.Array(McpToolDescriptor)

const McpContent = Schema.Union([
	Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
	Schema.Struct({ type: Schema.Literal("image"), data: Schema.String, mimeType: Schema.String }),
])
export type McpContent = typeof McpContent.Type

export const McpFailure = Schema.Struct({
	ok: Schema.Literal(false),
	message: Schema.String,
	tooLarge: Schema.optionalKey(Schema.Boolean),
	interrupted: Schema.optionalKey(Schema.Boolean),
	busy: Schema.optionalKey(Schema.Boolean),
})
export type McpFailure = typeof McpFailure.Type

export const McpListOutcome = Schema.Union([
	Schema.Struct({ ok: Schema.Literal(true), tools: Schema.optionalKey(McpToolDescriptors) }),
	McpFailure,
])
export type McpListOutcome = typeof McpListOutcome.Type

export const McpCallOutcome = Schema.Union([
	Schema.Struct({
		ok: Schema.Literal(true),
		content: Schema.Array(McpContent),
		structuredContent: Schema.optionalKey(Schema.Json),
		isError: Schema.Boolean,
	}),
	McpFailure,
])
export type McpCallOutcome = typeof McpCallOutcome.Type

export const MCP_CREDENTIAL_ENDED =
	"The credential for this MCP server is no longer available: it or its vault was archived or deleted."

export const MCP_CREDENTIAL_EMPTY =
	"The credential for this MCP server holds no secret. Send its token again with an update to the credential."

export const MCP_CALL_TIMEOUT_MS = 60_000
export const MCP_LIST_TIMEOUT_MS = 10_000

export const mcpTimedOut = (ms: number): McpFailure => ({
	ok: false,
	message: `The MCP server did not answer within ${ms / 1000} seconds.`,
})

export const withMcpDeadline = <A>(
	request: (signal: AbortSignal) => Promise<A>,
	signal: AbortSignal | undefined,
	ms = MCP_LIST_TIMEOUT_MS,
): Promise<A | McpFailure> =>
	Effect.runPromise(
		Effect.promise((deadline) =>
			request(signal === undefined ? deadline : AbortSignal.any([signal, deadline])),
		).pipe(Effect.timeoutOption(ms), Effect.map(Option.getOrElse(() => mcpTimedOut(ms)))),
	)

export const MAX_MCP_RESPONSE_BYTES = 4 * 1024 * 1024

export interface McpCallScope {
	readonly turn: number
	readonly signal?: AbortSignal | undefined
	readonly budget: { bytes: number; readonly limit: number; exceeded: boolean }
	readonly sent: Set<string>
}

export const mcpCallScope = (turn: number, limit: number, signal?: AbortSignal): McpCallScope => ({
	turn,
	signal,
	budget: { bytes: 0, limit, exceeded: false },
	sent: new Set(),
})

export const McpCall = Context.Reference<McpCallScope>("checkfu/McpCall", {
	defaultValue: () => mcpCallScope(-1, 0),
})

export type McpExit = (
	url: string,
	scope: McpCallScope,
) => { readonly token: string | null } | { readonly refused: string }
