import { ApiSelection } from "@checkfu/domain/Mcp/ApiServers"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/** The operations an agent's API server picks from its document. */
export const ApiSpecSelection = Schema.Struct({
	include: Schema.optionalKey(ApiSelection),
	exclude: Schema.optionalKey(ApiSelection),
})
export type ApiSpecSelection = typeof ApiSpecSelection.Type

/** What a document comes to as an API server's tools, or why it cannot be one. */
export const ApiSpecSummary = Schema.Union([
	Schema.Struct({
		ok: Schema.Literal(true),
		title: Schema.String,
		version: Schema.String,
		operations: Schema.Int,
	}),
	Schema.Struct({ ok: Schema.Literal(false), message: Schema.String }),
])
export type ApiSpecSummary = typeof ApiSpecSummary.Type

export interface ApiSpecCheckService {
	readonly check: (document: string, selection: ApiSpecSelection) => Effect.Effect<ApiSpecSummary>
}

/**
 * Imports an API server's document as the session will, with every bound applied. The importer
 * stays out of the API Worker, which asks the harness Worker instead. A setup
 * that provides no check refuses every API server instead of accepting it unchecked.
 */
export const ApiSpecCheck = Context.Reference<ApiSpecCheckService>("@checkfu/api/ApiSpecCheck", {
	defaultValue: () => ({
		check: () => Effect.die(new Error("No API spec check is provided.")),
	}),
})
