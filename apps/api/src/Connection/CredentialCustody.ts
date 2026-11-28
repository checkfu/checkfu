import { Credential } from "@checkfu/domain/Vault/Credential.aggregate"
import { CredentialId } from "@checkfu/domain/Vault/Credential.id"
import { CredentialSecrets } from "@checkfu/domain/Vault/CredentialSecrets.external"
import type { CredentialSecretsUnavailable } from "@checkfu/domain/Vault/CredentialSecrets.external"
import { Vault } from "@checkfu/domain/Vault/Vault.aggregate"
import { VaultId } from "@checkfu/domain/Vault/Vault.id"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import type { CredentialAccess } from "../Api.ts"
import type { HeldSecret, PutMode, PutOutcome } from "./SecretCustody.ts"

export class ConnectionCallFailed extends Schema.TaggedError<
	ConnectionCallFailed,
	{ readonly brand: unique symbol }
>()("ConnectionCallFailed", { cause: Schema.Unknown }) {}

export interface ConnectionExecutorService {
	readonly put: (
		vaultId: string,
		credentialId: string,
		secret: HeldSecret,
		target: string,
		mode: PutMode,
	) => Effect.Effect<PutOutcome, ConnectionCallFailed>
	readonly erase: (
		vaultId: string,
		credentialId: string,
	) => Effect.Effect<void, ConnectionCallFailed>
	readonly seal: (vaultId: string) => Effect.Effect<void, ConnectionCallFailed>
}

export class ConnectionExecutor extends Context.Service<
	ConnectionExecutor,
	ConnectionExecutorService
>()("@checkfu/api/ConnectionExecutor") {}

export const credentialAccessInVault = (vaultId: string, credentialId: string) =>
	Effect.gen(function* () {
		const credentials = yield* Credential
		const vaults = yield* Vault
		const credential = yield* credentials.get(CredentialId.make(credentialId))
		if (credential.vault_id !== vaultId || credential.status !== "active") {
			return "ended" satisfies CredentialAccess
		}
		const vault = yield* vaults.get(VaultId.make(vaultId))
		if (vault.status !== "active") {
			return "ended"
		}
		return credential.custody === "held" ? "held" : "empty"
	})

const UNAVAILABLE: CredentialSecretsUnavailable = { _tag: "CredentialSecretsUnavailable" }

const unavailable = (operation: string, id: string) => (error: ConnectionCallFailed) =>
	Effect.andThen(
		Effect.logError(`Credential secret not ${operation}`, id, error.cause),
		Effect.fail(UNAVAILABLE),
	)

export const CredentialSecretsLive = CredentialSecrets.toLayer(
	Effect.gen(function* () {
		const connections = yield* ConnectionExecutor
		return {
			put: (args) =>
				connections
					.put(
						args.vault_id,
						args.credential_id,
						{ type: "static_bearer", token: Redacted.value(args.secret) },
						args.mcp_server_url,
						args.mode,
					)
					.pipe(Effect.catchTag("ConnectionCallFailed", unavailable("put", args.credential_id))),
			erase: (args) =>
				connections.erase(args.vault_id, args.credential_id).pipe(
					Effect.tap(() => Effect.logInfo("Credential secret erased", args.credential_id)),
					Effect.catchTag("ConnectionCallFailed", unavailable("erased", args.credential_id)),
				),
			seal: (args) =>
				connections.seal(args.vault_id).pipe(
					Effect.tap(() => Effect.logInfo("Vault secrets erased", args.vault_id)),
					Effect.catchTag("ConnectionCallFailed", unavailable("erased", args.vault_id)),
				),
		}
	}),
)

export const makeConnectionExecutorLayer = (service: ConnectionExecutorService) =>
	Layer.succeed(ConnectionExecutor, service)
