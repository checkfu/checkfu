import * as Cloudflare from "@alchemy.run/cloudflare"
import type * as Effect from "effect/Effect"
import type { HttpRequestDescription } from "../OpenApi/OpenApiTypes.ts"
import type { ApiCallOutcome } from "./ApiUpstream.ts"
import type { ForwardOutcome, ForwardRequest } from "./McpTools.ts"
import type { CustodyReport, HeldSecret, SecretReplacement } from "./SecretCustody.ts"

/** The connection a session uses for a server: the bound credential's, or one named by the server's URL. */
export const connectionName = (binding: {
	readonly url: string
	readonly credential_id: string | null
}): string => binding.credential_id ?? `url:${binding.url}`

// Durable Object RPC methods: the stub calls them, so none can be a plain Effect value.
/* oxlint-disable effecttsgo/lazy-effect */
export interface ConnectionShape {
	readonly alarm: () => Effect.Effect<void>
	readonly storeSecret: (secret: HeldSecret, target: string) => Effect.Effect<boolean>
	readonly replaceSecret: (secret: SecretReplacement) => Effect.Effect<number | null>
	readonly keepSecret: () => Effect.Effect<void>
	readonly erase: () => Effect.Effect<void>
	readonly forward: (request: ForwardRequest) => Effect.Effect<ForwardOutcome>
	readonly refreshReport: () => Effect.Effect<CustodyReport | null>
	readonly acknowledgeRefresh: (refreshes: number) => Effect.Effect<void>
	readonly callApi: (
		baseUrl: string,
		request: HttpRequestDescription,
	) => Effect.Effect<ApiCallOutcome>
	/** Sends for a server bound without a credential, to the URL the request names, with no secret. */
	readonly forwardOpen: (request: ForwardRequest) => Effect.Effect<ForwardOutcome>
	readonly callOpenApi: (
		baseUrl: string,
		request: HttpRequestDescription,
	) => Effect.Effect<ApiCallOutcome>
}
/* oxlint-enable effecttsgo/lazy-effect */

/**
 * One object per credential, named by the credential's id: the only place the
 * credential's secret exists, the only sender of requests to the MCP server or
 * API it was stored for, and the only one that refreshes its token. Sessions
 * keep their own MCP clients and send through it, so they never share protocol
 * state and never hold the secret. A server used without a credential is sent
 * to through an object named by its URL, so every request takes the same path.
 */
export class Connection extends Cloudflare.DurableObject<Connection, ConnectionShape>()(
	"Connection",
) {}
