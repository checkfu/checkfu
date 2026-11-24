import { CredentialSecrets } from "@checkfu/domain/Vault/CredentialSecrets.external"
import type { CredentialSecretsUnavailable } from "@checkfu/domain/Vault/CredentialSecrets.external"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"

export class ConnectionCallFailed extends Schema.TaggedError<
	ConnectionCallFailed,
	{ readonly brand: unique symbol }
>()("ConnectionCallFailed", { cause: Schema.Unknown }) {}

/** How the API reaches a credential's connection object, by credential id. */
export interface ConnectionExecutorService {
	readonly storeSecret: (
		credentialId: string,
		secret: string,
		mcpServerUrl: string,
	) => Effect.Effect<boolean, ConnectionCallFailed>
	readonly replaceSecret: (
		credentialId: string,
		secret: string,
	) => Effect.Effect<boolean, ConnectionCallFailed>
	readonly keepSecret: (credentialId: string) => Effect.Effect<void, ConnectionCallFailed>
	readonly erase: (credentialId: string) => Effect.Effect<void, ConnectionCallFailed>
}

export class ConnectionExecutor extends Context.Service<
	ConnectionExecutor,
	ConnectionExecutorService
>()("@checkfu/api/ConnectionExecutor") {}

const UNAVAILABLE: CredentialSecretsUnavailable = { _tag: "CredentialSecretsUnavailable" }

const unavailable = (operation: string, credentialId: string) => (error: ConnectionCallFailed) =>
	Effect.andThen(
		Effect.logError(`Credential secret not ${operation}`, credentialId, error.cause),
		Effect.fail(UNAVAILABLE),
	)

export const CredentialSecretsLive = CredentialSecrets.toLayer(
	Effect.gen(function* () {
		const connections = yield* ConnectionExecutor
		return {
			store: (args) =>
				connections
					.storeSecret(args.credential_id, Redacted.value(args.secret), args.mcp_server_url)
					.pipe(
						Effect.map((stored) => ({ stored })),
						Effect.catchTag("ConnectionCallFailed", unavailable("stored", args.credential_id)),
					),
			replace: (args) =>
				connections.replaceSecret(args.credential_id, Redacted.value(args.secret)).pipe(
					Effect.map((replaced) => ({ replaced })),
					Effect.catchTag("ConnectionCallFailed", unavailable("replaced", args.credential_id)),
				),
			// A connection that cannot be reached fails the delivery, which is then delivered again.
			keep: (args) => Effect.orDie(connections.keepSecret(args.credential_id)),
			erase: (args) =>
				connections.erase(args.credential_id).pipe(
					Effect.tap(() => Effect.logInfo("Credential secret erased", args.credential_id)),
					Effect.orDie,
				),
		}
	}),
)

export const makeConnectionExecutorLayer = (service: ConnectionExecutorService) =>
	Layer.succeed(ConnectionExecutor, service)
