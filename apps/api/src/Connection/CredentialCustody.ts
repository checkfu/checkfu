import { CredentialSecrets } from "@checkfu/domain/Vault/CredentialSecrets.external"
import type { CredentialSecretsUnavailable } from "@checkfu/domain/Vault/CredentialSecrets.external"
import type {
	CredentialSecretMaterial,
	CredentialSecretReplacement,
} from "@checkfu/domain/Vault/VaultTypes"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import type { CustodyReport, HeldSecret, SecretReplacement } from "./SecretCustody.ts"

export class ConnectionCallFailed extends Schema.TaggedError<
	ConnectionCallFailed,
	{ readonly brand: unique symbol }
>()("ConnectionCallFailed", { cause: Schema.Unknown }) {}

/** How the API reaches a credential's connection object, by credential id. */
export interface ConnectionExecutorService {
	readonly storeSecret: (
		credentialId: string,
		secret: HeldSecret,
		target: string,
	) => Effect.Effect<boolean, ConnectionCallFailed>
	/** The secret's new revision, or null when it held nothing to replace. */
	readonly replaceSecret: (
		credentialId: string,
		secret: SecretReplacement,
	) => Effect.Effect<number | null, ConnectionCallFailed>
	readonly keepSecret: (credentialId: string) => Effect.Effect<void, ConnectionCallFailed>
	readonly erase: (credentialId: string) => Effect.Effect<void, ConnectionCallFailed>
	/** What the credential's last token refresh came to, until it is acknowledged. */
	readonly refreshReport: (
		credentialId: string,
	) => Effect.Effect<CustodyReport | null, ConnectionCallFailed>
	readonly acknowledgeRefresh: (
		credentialId: string,
		refreshes: number,
	) => Effect.Effect<void, ConnectionCallFailed>
}

export class ConnectionExecutor extends Context.Service<
	ConnectionExecutor,
	ConnectionExecutorService
>()("@checkfu/api/ConnectionExecutor") {}

const millis = (at: DateTime.Utc | null): number | null =>
	at === null ? null : DateTime.toEpochMillis(at)

/** The one place a secret leaves its wrapper: on its way into the connection that holds it. */
const held = (secret: CredentialSecretMaterial): HeldSecret => {
	if (secret.type === "static_bearer") {
		return { type: "static_bearer", token: Redacted.value(secret.token) }
	}
	if (secret.type === "api_key") {
		return { type: "api_key", token: Redacted.value(secret.token), placement: secret.placement }
	}
	const { refresh } = secret
	return {
		type: "mcp_oauth",
		access_token: Redacted.value(secret.access_token),
		expires_at: millis(secret.expires_at),
		refresh:
			refresh === null
				? null
				: {
						token_endpoint: refresh.token_endpoint,
						client_id: refresh.client_id,
						scope: refresh.scope,
						auth:
							refresh.token_endpoint_auth.type === "none"
								? { type: "none" }
								: {
										type: refresh.token_endpoint_auth.type,
										client_secret: Redacted.value(refresh.token_endpoint_auth.client_secret),
									},
						refresh_token: Redacted.value(refresh.refresh_token),
					},
		refresh_failed: false,
	}
}

const replacement = (secret: CredentialSecretReplacement): SecretReplacement =>
	secret.type !== "mcp_oauth"
		? { type: secret.type, token: Redacted.value(secret.token) }
		: {
				type: "mcp_oauth",
				access_token: Redacted.value(secret.access_token),
				expires_at: millis(secret.expires_at),
				refresh_token: secret.refresh_token === null ? null : Redacted.value(secret.refresh_token),
			}

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
				connections.storeSecret(args.credential_id, held(args.secret), args.mcp_server_url).pipe(
					Effect.map((stored) => ({ stored })),
					Effect.catchTag("ConnectionCallFailed", unavailable("stored", args.credential_id)),
				),
			replace: (args) =>
				connections.replaceSecret(args.credential_id, replacement(args.secret)).pipe(
					Effect.map((revision) => ({ revision })),
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
