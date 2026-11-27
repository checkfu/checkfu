import { ERROR_CODES } from "@checkfu/sdk/ErrorCodes"
import { ArchiveCredential } from "@checkfu/domain/Vault/ArchiveCredential.command"
import { ArchiveCredentialDecision } from "@checkfu/domain/Vault/ArchiveCredential.decision"
import { ArchiveVault } from "@checkfu/domain/Vault/ArchiveVault.command"
import { ConfirmCredentialStored } from "@checkfu/domain/Vault/ConfirmCredentialStored.command"
import { ConfirmCredentialStoredDecision } from "@checkfu/domain/Vault/ConfirmCredentialStored.decision"
import {
	CreateCredential,
	CredentialUrlConflict,
} from "@checkfu/domain/Vault/CreateCredential.command"
import { CreateCredentialDecision } from "@checkfu/domain/Vault/CreateCredential.decision"
import { CreateVault } from "@checkfu/domain/Vault/CreateVault.command"
import { Credential } from "@checkfu/domain/Vault/Credential.aggregate"
import { CredentialId } from "@checkfu/domain/Vault/Credential.id"
import { CredentialArchivedError } from "@checkfu/domain/Vault/CredentialArchived.rejection"
import { CredentialSecrets } from "@checkfu/domain/Vault/CredentialSecrets.external"
import { CredentialView } from "@checkfu/domain/Vault/CredentialView.view"
import { DeleteCredential } from "@checkfu/domain/Vault/DeleteCredential.command"
import { DeleteCredentialDecision } from "@checkfu/domain/Vault/DeleteCredential.decision"
import { DeleteVault } from "@checkfu/domain/Vault/DeleteVault.command"
import { makeRevokeCredentialSecret } from "@checkfu/domain/Vault/RevokeCredentialSecret"
import { RotateCredential } from "@checkfu/domain/Vault/RotateCredential.command"
import { RotateCredentialDecision } from "@checkfu/domain/Vault/RotateCredential.decision"
import { UpdateCredential } from "@checkfu/domain/Vault/UpdateCredential.command"
import { UpdateCredentialDecision } from "@checkfu/domain/Vault/UpdateCredential.decision"
import { UpdateVault } from "@checkfu/domain/Vault/UpdateVault.command"
import { Vault } from "@checkfu/domain/Vault/Vault.aggregate"
import { VaultId } from "@checkfu/domain/Vault/Vault.id"
import { VaultArchivedError } from "@checkfu/domain/Vault/VaultArchived.rejection"
import { McpServerUrl } from "@checkfu/domain/Vault/VaultTypes"
import { VaultView } from "@checkfu/domain/Vault/VaultView.view"
import * as Context from "effect/Context"
import * as Redacted from "effect/Redacted"
import * as Digest from "effect/crypto/Digest"
import * as SecureRandom from "effect/crypto/SecureRandom"
import type * as Duration from "effect/Duration"
import { RuntimeContext } from "alchemy/RuntimeContext"
import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import * as Option from "effect/Option"
import { CheckfuApi } from "./Api.ts"
import { makeVaultListers } from "./Listing.ts"
import {
	reusedKey,
	bestEffortAfterCommit,
	commitForStream,
	createIdentity,
	handled,
	isPending,
	orPending,
	present,
	reject,
	sha256Json,
} from "./HttpHelpers.ts"

export const VaultReadWaitTimeout = Context.Reference<Duration.Input>(
	"@checkfu/api/VaultReadWaitTimeout",
	{ defaultValue: () => "5 seconds" },
)

const latest = <C>(...receipts: ReadonlyArray<ReadonlyArray<C>>): ReadonlyArray<C> =>
	receipts.findLast((commits) => commits.length > 0) ?? []

export const VaultsLive = HttpApiBuilder.group(CheckfuApi, "vaults", (handlers) =>
	Effect.gen(function* () {
		const vaults = yield* Vault
		const vaultViews = yield* VaultView
		const credentials = yield* Credential
		const credentialViews = yield* CredentialView
		const createCredential = yield* CreateCredentialDecision
		const archiveCredential = yield* ArchiveCredentialDecision
		const deleteCredential = yield* DeleteCredentialDecision
		const rotateCredential = yield* RotateCredentialDecision
		const updateCredential = yield* UpdateCredentialDecision
		const confirmStored = yield* ConfirmCredentialStoredDecision
		const secrets = yield* CredentialSecrets
		const inRuntime = Effect.provideService(RuntimeContext, yield* RuntimeContext)
		const revokeSecret = yield* makeRevokeCredentialSecret
		const digest = yield* Digest.Digest
		const random = yield* SecureRandom.SecureRandom
		const list = yield* makeVaultListers

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

		const urlOf = (vaultId: VaultId, id: CredentialId) =>
			Effect.gen(function* () {
				const committed = yield* credentials.get(id)
				return committed.status === "" || committed.vault_id !== vaultId
					? yield* reject(404, `Credential ${id} not found.`)
					: committed.mcp_server_url
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

		const vaultAfter = (
			id: VaultId,
			receipt: { readonly stream: string; readonly version: number },
		) => vaultViews.get(Vault.ref(id), { atLeast: receipt }).pipe(orPending(id, "vault"))

		const credentialAfter = (
			vaultId: VaultId,
			id: CredentialId,
			commits: ReadonlyArray<{ readonly stream: string; readonly version: number }>,
		) => {
			const commit = commitForStream(commits, `Credential/${id}`)
			return credentialViews
				.get(Credential.ref(id), commit === undefined ? {} : { atLeast: commit })
				.pipe(
					orPending(id, "vault_credential"),
					Effect.map((read) => (isPending(read) ? { ...read, vault_id: vaultId } : read)),
				)
		}

		const revoked = (vaultId: VaultId, id: CredentialId) =>
			revokeSecret(vaultId, id).pipe(
				inRuntime,
				Effect.as(true),
				Effect.catchDefect((defect) =>
					Effect.as(
						Effect.logWarning("Credential secret erasure left to its policy", id, defect),
						false,
					),
				),
			)

		const sealed = (id: VaultId) =>
			secrets.seal({ vault_id: id }).pipe(
				inRuntime,
				Effect.as(true),
				Effect.catchDefect((defect) =>
					Effect.as(Effect.logWarning("Vault seal left to its policy", id, defect), false),
				),
			)

		const erasedCredential = (vaultId: VaultId, id: CredentialId, confirmed: boolean) =>
			Effect.gen(function* () {
				const pending = {
					id,
					type: "vault_credential" as const,
					vault_id: vaultId,
					pending: true as const,
				}
				const projected = confirmed
					? yield* credentialViews
							.waitFor(
								Credential.ref(id),
								{ custody: "erased" },
								{ timeout: yield* VaultReadWaitTimeout },
							)
							.pipe(Effect.catchTag("WaitTimeout", () => Effect.succeed(null)))
					: null
				if (projected !== null) {
					return projected
				}
				const committed = yield* credentials.get(id)
				const parent = yield* vaults.get(vaultId)
				return [
					committed.status === "",
					committed.status === "deleted",
					committed.vault_id !== vaultId,
					parent.status === "",
					parent.status === "deleted",
				].some(Boolean)
					? yield* reject(404, `Credential ${id} not found.`)
					: pending
			})

		const stored = (vault_id: VaultId, credential_id: CredentialId) =>
			confirmStored
				.send(new ConfirmCredentialStored({ vault_id, credential_id }))
				.pipe(
					Effect.catchDefect(() =>
						reject(
							503,
							`Credential ${credential_id} holds its token, but that was not recorded. Send the token again.`,
						),
					),
				)

		return handlers
			.handle("create", ({ payload, headers }) =>
				Effect.gen(function* () {
					const identity = yield* createIdentity(digest, random, {
						resource: "vault",
						prefix: "vlt",
						key: headers["idempotency-key"],
						body: { display_name: payload.display_name },
					})
					const id = VaultId.make(identity.id)
					const receipt = yield* vaults
						.send(
							new CreateVault({ vault_id: id, display_name: payload.display_name }),
							identity.options,
						)
						.pipe(Effect.catchTag("VaultAlreadyExists", () => reusedKey))
					const result = yield* vaultAfter(id, receipt)
					if (isPending(result)) {
						return result
					}
					return yield* present(result, 404, `Vault ${id} was deleted after creation committed.`)
				}).pipe(handled),
			)
			.handle("list", ({ query }) =>
				list
					.vaults("vault", query, (id) =>
						Effect.gen(function* () {
							const vaultId = VaultId.make(id)
							yield* requireVault(vaultId)
							return yield* readVault(vaultId)
						}),
					)
					.pipe(handled),
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
					const result = yield* vaultAfter(id, receipt)
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
					const confirmed = yield* sealed(id)
					yield* vaultViews.get(Vault.ref(id), { atLeast: receipt }).pipe(bestEffortAfterCommit)
					const { storing, held, erasing } = yield* vaults.get(id)
					return {
						id,
						type: "vault_deleted" as const,
						secrets: confirmed ? ("erased" as const) : ("erasing" as const),
						custody: { storing, held, erasing },
					}
				}).pipe(handled),
			)
			.handle("archive", ({ params }) =>
				Effect.gen(function* () {
					const id = params.vault_id
					const receipt = yield* vaults.send(new ArchiveVault({ vault_id: id }))
					if (!(yield* sealed(id))) {
						return { id, type: "vault" as const, pending: true as const }
					}
					const result = yield* vaultAfter(id, receipt)
					if (isPending(result)) {
						return result
					}
					return yield* present(result, 404, `Vault ${id} not found.`)
				}).pipe(handled),
			)
			.handle("createCredential", ({ params, payload, headers }) =>
				Effect.gen(function* () {
					yield* requireVault(params.vault_id)
					const auth = {
						type: "static_bearer" as const,
						mcp_server_url: payload.auth.mcp_server_url,
					}
					const display_name = payload.display_name ?? null
					const identity = yield* createIdentity(digest, random, {
						resource: "vault_credential",
						prefix: "vcrd",
						key: headers["idempotency-key"],
						scope: [params.vault_id],
						body: {
							vault_id: params.vault_id,
							auth,
							display_name,
							token: yield* sha256Json(digest, [
								"vault_credential.token",
								Redacted.value(payload.auth.token),
							]),
						},
					})
					const id = CredentialId.make(identity.id)
					const receipt = yield* createCredential
						.send(
							new CreateCredential({
								vault_id: params.vault_id,
								credential_id: id,
								auth,
								display_name,
							}),
							identity.options,
						)
						.pipe(
							Effect.catchTags({
								CredentialAlreadyExists: () => reusedKey,
								CredentialUrlConflict: () =>
									reject(
										409,
										CredentialUrlConflict.annotations.description ?? "Request rejected.",
										{
											code: ERROR_CODES.credentialUrlTaken,
										},
									),
							}),
						)
					yield* secrets
						.put({
							vault_id: params.vault_id,
							credential_id: id,
							secret: payload.auth.token,
							mcp_server_url: auth.mcp_server_url,
							mode: "create",
						})
						.pipe(
							inRuntime,
							Effect.catchTag("CredentialSecretsUnavailable", () =>
								reject(
									503,
									`Credential ${id} was created, but its token was not stored. Send the token again: ${
										identity.options === undefined
											? "update the credential with it"
											: "retry this request with the same Idempotency-Key"
									}.`,
								),
							),
						)
					const confirmed = yield* stored(params.vault_id, id)
					const result = yield* credentialAfter(
						params.vault_id,
						id,
						latest(receipt.commits, confirmed.commits),
					)
					if (isPending(result)) {
						return result
					}
					return yield* present(
						result,
						404,
						`Credential ${id} was deleted after creation committed.`,
					)
				}).pipe(handled),
			)
			.handle("listCredentials", ({ params, query }) =>
				Effect.gen(function* () {
					yield* requireVault(params.vault_id)
					return yield* list.credentials(
						"vault_credential",
						{ ...query, agent_id: params.vault_id },
						(id) =>
							Effect.gen(function* () {
								const credentialId = CredentialId.make(id)
								yield* requireCredential(params.vault_id, credentialId)
								return yield* readCredential(credentialId)
							}),
					)
				}).pipe(handled),
			)
			.handle("getCredential", ({ params }) =>
				Effect.gen(function* () {
					yield* requireCredential(params.vault_id, params.credential_id)
					return yield* readCredential(params.credential_id)
				}).pipe(handled),
			)
			.handle("updateCredential", ({ params, payload }) =>
				Effect.gen(function* () {
					const vault_id = params.vault_id
					const id = params.credential_id
					const token = payload.auth?.token
					let earlier: ReadonlyArray<{ readonly stream: string; readonly version: number }> = []
					if (token !== undefined && token !== null) {
						const committed = yield* requireCredential(vault_id, id)
						if (committed.custody !== "held" && committed.custody !== "storing") {
							return yield* new CredentialArchivedError({ credential_id: id })
						}
						if ((yield* vaults.get(vault_id)).status !== "active") {
							return yield* new VaultArchivedError({ vault_id })
						}
						const put = yield* secrets
							.put({
								vault_id,
								credential_id: id,
								secret: token,
								mcp_server_url: McpServerUrl.make(committed.mcp_server_url),
								mode: "replace",
							})
							.pipe(
								inRuntime,
								Effect.catchTag("CredentialSecretsUnavailable", () =>
									reject(503, "Credential storage is unavailable. Send the token again."),
								),
							)
						if (put.refused !== null) {
							return yield* reject(409, `Credential ${id} no longer holds a secret.`)
						}
						const confirmed = yield* stored(vault_id, id)
						const rotated = yield* rotateCredential
							.send(new RotateCredential({ vault_id, credential_id: id }))
							.pipe(
								Effect.catchDefect(() =>
									reject(
										503,
										`Credential ${id} holds the new token, but the rotation was not recorded. Send the token again.`,
									),
								),
							)
						earlier = latest(confirmed.commits, rotated.commits)
					}
					const receipt = yield* updateCredential.send(
						new UpdateCredential({
							vault_id,
							credential_id: id,
							changes:
								payload.display_name === undefined ? {} : { display_name: payload.display_name },
						}),
					)
					const result = yield* credentialAfter(vault_id, id, latest(earlier, receipt.commits))
					if (isPending(result)) {
						return result
					}
					return yield* present(result, 404, `Credential ${id} not found.`)
				}).pipe(handled),
			)
			.handle("deleteCredential", ({ params }) =>
				Effect.gen(function* () {
					const id = params.credential_id
					const receipt = yield* deleteCredential.send(
						new DeleteCredential({
							vault_id: params.vault_id,
							credential_id: id,
							mcp_server_url: yield* urlOf(params.vault_id, id),
						}),
					)
					yield* revoked(params.vault_id, id)
					yield* credentialAfter(params.vault_id, id, receipt.commits).pipe(
						Effect.asVoid,
						bestEffortAfterCommit,
					)
					const { custody } = yield* credentials.get(id)
					return {
						id,
						type: "vault_credential_deleted" as const,
						custody: custody === "erased" ? ("erased" as const) : ("erasing" as const),
					}
				}).pipe(handled),
			)
			.handle("archiveCredential", ({ params }) =>
				Effect.gen(function* () {
					const id = params.credential_id
					yield* archiveCredential.send(
						new ArchiveCredential({
							vault_id: params.vault_id,
							credential_id: id,
							mcp_server_url: yield* urlOf(params.vault_id, id),
						}),
					)
					const confirmed = yield* revoked(params.vault_id, id)
					return yield* erasedCredential(params.vault_id, id, confirmed)
				}).pipe(handled),
			)
	}),
)
