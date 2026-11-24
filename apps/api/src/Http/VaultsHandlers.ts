import { ArchiveCredential } from "@checkfu/domain/Vault/ArchiveCredential.command"
import { ArchiveCredentialDecision } from "@checkfu/domain/Vault/ArchiveCredential.decision"
import { ArchiveVault } from "@checkfu/domain/Vault/ArchiveVault.command"
import { CreateCredential } from "@checkfu/domain/Vault/CreateCredential.command"
import { CreateCredentialDecision } from "@checkfu/domain/Vault/CreateCredential.decision"
import { CreateVault } from "@checkfu/domain/Vault/CreateVault.command"
import { Credential } from "@checkfu/domain/Vault/Credential.aggregate"
import { CredentialId } from "@checkfu/domain/Vault/Credential.id"
import { CredentialSecrets } from "@checkfu/domain/Vault/CredentialSecrets.external"
import { CredentialView } from "@checkfu/domain/Vault/CredentialView.view"
import { DeleteCredential } from "@checkfu/domain/Vault/DeleteCredential.command"
import { DeleteCredentialDecision } from "@checkfu/domain/Vault/DeleteCredential.decision"
import { DeleteVault } from "@checkfu/domain/Vault/DeleteVault.command"
import { RotateCredential } from "@checkfu/domain/Vault/RotateCredential.command"
import { UpdateCredential } from "@checkfu/domain/Vault/UpdateCredential.command"
import { UpdateVault } from "@checkfu/domain/Vault/UpdateVault.command"
import { Vault } from "@checkfu/domain/Vault/Vault.aggregate"
import { VaultId } from "@checkfu/domain/Vault/Vault.id"
import type { CredentialAuth, CredentialSecretMaterial } from "@checkfu/domain/Vault/VaultTypes"
import { VaultView } from "@checkfu/domain/Vault/VaultView.view"
import * as Context from "effect/Context"
import * as SecureRandom from "effect/crypto/SecureRandom"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import * as Option from "effect/Option"
import { makeCredentialRefreshRecorder } from "../Connection/CredentialRefresh.ts"
import { CheckfuApi } from "./Api.ts"
import type { CreateCredentialBody } from "./Api.ts"
import {
	bestEffortAfterCommit,
	commitForStream,
	handled,
	isPending,
	normalizeMcpServerUrl,
	orPending,
	present,
	randomId,
	reject,
} from "./HttpHelpers.ts"

/** A new credential's two halves: what its record says, and the secrets only its connection gets. */
const splitAuth = (
	auth: CreateCredentialBody["auth"],
	mcpServerUrl: string,
): { readonly auth: CredentialAuth; readonly secret: CredentialSecretMaterial } | undefined => {
	if (auth.type === "static_bearer") {
		return {
			auth: { type: "static_bearer", mcp_server_url: mcpServerUrl },
			secret: { type: "static_bearer", token: auth.token },
		}
	}
	const expires_at = auth.expires_at ?? null
	const refresh = auth.refresh ?? null
	if (refresh === null) {
		return {
			auth: { type: "mcp_oauth", mcp_server_url: mcpServerUrl, expires_at, refresh: null },
			secret: { type: "mcp_oauth", access_token: auth.access_token, expires_at, refresh: null },
		}
	}
	const token_endpoint = normalizeMcpServerUrl(refresh.token_endpoint)
	if (token_endpoint === undefined) {
		return undefined
	}
	const shared = { token_endpoint, client_id: refresh.client_id, scope: refresh.scope ?? null }
	return {
		auth: {
			type: "mcp_oauth",
			mcp_server_url: mcpServerUrl,
			expires_at,
			refresh: { ...shared, token_endpoint_auth: { type: refresh.token_endpoint_auth.type } },
		},
		secret: {
			type: "mcp_oauth",
			access_token: auth.access_token,
			expires_at,
			refresh: {
				...shared,
				token_endpoint_auth: refresh.token_endpoint_auth,
				refresh_token: refresh.refresh_token,
			},
		},
	}
}

export const VaultReadWaitTimeout = Context.Reference<Duration.Input>(
	"@checkfu/api/VaultReadWaitTimeout",
	{ defaultValue: () => "5 seconds" },
)

export const VaultsLive = HttpApiBuilder.group(CheckfuApi, "vaults", (handlers) =>
	Effect.gen(function* () {
		const vaults = yield* Vault
		const vaultViews = yield* VaultView
		const credentials = yield* Credential
		const credentialViews = yield* CredentialView
		const recordCredentialRefresh = yield* makeCredentialRefreshRecorder
		const createCredential = yield* CreateCredentialDecision
		const archiveCredential = yield* ArchiveCredentialDecision
		const deleteCredential = yield* DeleteCredentialDecision
		const secrets = yield* CredentialSecrets
		const random = yield* SecureRandom.SecureRandom

		// The aggregate says whether it exists, so a view that lags a delete cannot bring it back.
		const requireVault = (id: VaultId) =>
			Effect.gen(function* () {
				const committed = yield* vaults.get(id)
				if (committed.status === "" || committed.status === "deleted") {
					return yield* reject(404, `Vault ${id} not found.`)
				}
				return committed
			})

		const requireCredential = (vaultId: VaultId, id: CredentialId) =>
			Effect.gen(function* () {
				yield* requireVault(vaultId)
				const committed = yield* credentials.get(id)
				if (
					committed.status === "" ||
					committed.status === "deleted" ||
					committed.vault_id !== vaultId
				) {
					return yield* reject(404, `Credential ${id} not found.`)
				}
				return committed
			})

		const readVault = (id: VaultId) =>
			Effect.gen(function* () {
				const ref = Vault.ref(id)
				const found = Option.getOrNull(yield* vaultViews.get(ref))
				if (found !== null) {
					return found
				}
				const timeout = yield* VaultReadWaitTimeout
				const projected = yield* vaultViews.waitFor(ref, { type: "vault" }, { timeout })
				return projected ?? (yield* reject(503, `Vault ${id} projection is not ready.`))
			})

		const readCredential = (id: CredentialId) =>
			Effect.gen(function* () {
				const ref = Credential.ref(id)
				const found = Option.getOrNull(yield* credentialViews.get(ref))
				if (found !== null) {
					return found
				}
				const timeout = yield* VaultReadWaitTimeout
				const projected = yield* credentialViews.waitFor(
					ref,
					{ type: "vault_credential" },
					{ timeout },
				)
				return projected ?? (yield* reject(503, `Credential ${id} projection is not ready.`))
			})

		const credentialAfter = (
			id: CredentialId,
			commits: ReadonlyArray<{ readonly stream: string; readonly version: number }>,
		) => {
			const commit = commitForStream(commits, `Credential/${id}`)
			return credentialViews
				.get(Credential.ref(id), commit === undefined ? {} : { atLeast: commit })
				.pipe(orPending(id, "vault_credential"))
		}

		return handlers
			.handle("create", ({ payload }) =>
				Effect.gen(function* () {
					const id = VaultId.make(yield* randomId(random, "vlt"))
					const receipt = yield* vaults.send(
						new CreateVault({ vault_id: id, display_name: payload.display_name }),
					)
					const result = yield* vaultViews
						.get(Vault.ref(id), { atLeast: receipt })
						.pipe(orPending(id, "vault"))
					if (isPending(result)) {
						return result
					}
					return yield* present(result, 404, `Vault ${id} was deleted after creation committed.`)
				}).pipe(handled),
			)
			.handle("get", ({ params }) =>
				Effect.gen(function* () {
					yield* requireVault(params.vault_id)
					return yield* readVault(params.vault_id)
				}).pipe(handled),
			)
			.handle("update", ({ params, payload }) =>
				Effect.gen(function* () {
					const id = params.vault_id
					const receipt = yield* vaults.send(
						new UpdateVault({
							vault_id: id,
							changes:
								payload.display_name === undefined || payload.display_name === null
									? {}
									: { display_name: payload.display_name },
						}),
					)
					const result = yield* vaultViews
						.get(Vault.ref(id), { atLeast: receipt })
						.pipe(orPending(id, "vault"))
					if (isPending(result)) {
						return result
					}
					return yield* present(result, 404, `Vault ${id} not found.`)
				}).pipe(handled),
			)
			.handle("delete", ({ params }) =>
				Effect.gen(function* () {
					const id = params.vault_id
					const receipt = yield* vaults.send(new DeleteVault({ vault_id: id }))
					yield* vaultViews.get(Vault.ref(id), { atLeast: receipt }).pipe(bestEffortAfterCommit)
					return { id, type: "vault_deleted" as const }
				}).pipe(handled),
			)
			.handle("archive", ({ params }) =>
				Effect.gen(function* () {
					const id = params.vault_id
					const receipt = yield* vaults.send(new ArchiveVault({ vault_id: id }))
					const result = yield* vaultViews
						.get(Vault.ref(id), { atLeast: receipt })
						.pipe(orPending(id, "vault"))
					if (isPending(result)) {
						return result
					}
					return yield* present(result, 404, `Vault ${id} not found.`)
				}).pipe(handled),
			)
			.handle("createCredential", ({ params, payload }) =>
				Effect.gen(function* () {
					const mcpServerUrl = normalizeMcpServerUrl(payload.auth.mcp_server_url)
					if (mcpServerUrl === undefined) {
						return yield* reject(400, "auth.mcp_server_url is not a valid URL.")
					}
					const split = splitAuth(payload.auth, mcpServerUrl)
					if (split === undefined) {
						return yield* reject(400, "auth.refresh.token_endpoint is not a valid URL.")
					}
					yield* requireVault(params.vault_id)
					const id = CredentialId.make(yield* randomId(random, "vcrd"))
					// The secret goes straight to the credential's connection: no command carries it.
					const { stored } = yield* secrets
						.store({ credential_id: id, secret: split.secret, mcp_server_url: mcpServerUrl })
						.pipe(
							Effect.catchTag("CredentialSecretsUnavailable", () =>
								reject(503, "Credential storage is unavailable. Try again."),
							),
						)
					if (!stored) {
						return yield* reject(500, "Failed to store the credential.")
					}
					const receipt = yield* createCredential
						.send(
							new CreateCredential({
								vault_id: params.vault_id,
								credential_id: id,
								auth: split.auth,
								display_name: payload.display_name ?? null,
							}),
						)
						.pipe(
							// A rejection is certain: the credential does not exist, so neither may its secret.
							Effect.tapError(() =>
								secrets
									.erase({ credential_id: id })
									.pipe(
										Effect.catchDefect((defect) =>
											Effect.logError("Rejected credential's secret not erased", id, defect),
										),
									),
							),
						)
					const result = yield* credentialAfter(id, receipt.commits)
					if (isPending(result)) {
						return result
					}
					return yield* present(result, 404, `Credential ${id} not found.`)
				}).pipe(handled),
			)
			.handle("listCredentials", ({ params }) =>
				Effect.gen(function* () {
					const vault = yield* requireVault(params.vault_id)
					const data = yield* Effect.forEach(
						vault.credentials,
						(held) =>
							Effect.andThen(
								recordCredentialRefresh(held.credential_id),
								readCredential(held.credential_id),
							),
						{ concurrency: "unbounded" },
					)
					return { data }
				}).pipe(handled),
			)
			.handle("getCredential", ({ params }) =>
				Effect.gen(function* () {
					yield* requireCredential(params.vault_id, params.credential_id)
					yield* recordCredentialRefresh(params.credential_id)
					return yield* readCredential(params.credential_id)
				}).pipe(handled),
			)
			.handle("updateCredential", ({ params, payload }) =>
				Effect.gen(function* () {
					const id = params.credential_id
					// Checked before the secret is touched, so no other vault can replace it.
					yield* requireCredential(params.vault_id, id)
					const commits: Array<{ readonly stream: string; readonly version: number }> = []
					const { auth } = payload
					if (auth !== undefined) {
						const current = (yield* readCredential(id)).auth
						if (current.type !== auth.type) {
							return yield* reject(400, `auth.type cannot change: it is ${current.type}.`)
						}
						if (
							auth.type === "mcp_oauth" &&
							auth.refresh !== undefined &&
							(current.type !== "mcp_oauth" || current.refresh === null)
						) {
							return yield* reject(
								400,
								"auth.refresh can only replace the refresh token of a credential created with refresh.",
							)
						}
					}
					const replacement =
						auth === undefined
							? undefined
							: auth.type === "mcp_oauth"
								? {
										type: "mcp_oauth" as const,
										access_token: auth.access_token,
										expires_at: auth.expires_at ?? null,
										refresh_token: auth.refresh?.refresh_token ?? null,
									}
								: auth.token === undefined || auth.token === null
									? undefined
									: { type: "static_bearer" as const, token: auth.token }
					if (replacement !== undefined) {
						const { revision } = yield* secrets
							.replace({ credential_id: id, secret: replacement })
							.pipe(
								Effect.catchTag("CredentialSecretsUnavailable", () =>
									reject(503, "Credential storage is unavailable. Send the token again."),
								),
							)
						if (revision === null) {
							return yield* reject(409, `Credential ${id} no longer holds a secret.`)
						}
						commits.push(
							yield* credentials.send(
								new RotateCredential({
									vault_id: params.vault_id,
									credential_id: id,
									expires_at: replacement.type === "mcp_oauth" ? replacement.expires_at : null,
									revision,
								}),
							),
						)
					}
					if (payload.display_name !== undefined) {
						commits.push(
							yield* credentials.send(
								new UpdateCredential({
									vault_id: params.vault_id,
									credential_id: id,
									changes: { display_name: payload.display_name },
								}),
							),
						)
					}
					const result = yield* credentialAfter(id, commits.slice(-1))
					if (isPending(result)) {
						return result
					}
					return yield* present(result, 404, `Credential ${id} not found.`)
				}).pipe(handled),
			)
			.handle("deleteCredential", ({ params }) =>
				Effect.gen(function* () {
					const id = params.credential_id
					yield* requireVault(params.vault_id)
					const receipt = yield* deleteCredential.send(
						new DeleteCredential({ vault_id: params.vault_id, credential_id: id }),
					)
					yield* credentialAfter(id, receipt.commits).pipe(Effect.asVoid, bestEffortAfterCommit)
					return { id, type: "vault_credential_deleted" as const }
				}).pipe(handled),
			)
			.handle("archiveCredential", ({ params }) =>
				Effect.gen(function* () {
					const id = params.credential_id
					yield* requireVault(params.vault_id)
					const receipt = yield* archiveCredential.send(
						new ArchiveCredential({ vault_id: params.vault_id, credential_id: id }),
					)
					const result = yield* credentialAfter(id, receipt.commits)
					if (isPending(result)) {
						return result
					}
					return yield* present(result, 404, `Credential ${id} not found.`)
				}).pipe(handled),
			)
	}),
)
