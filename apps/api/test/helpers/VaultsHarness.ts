import { ListingStore } from "@checkfu/domain/Listing/ListingStore"
import * as Domain from "@alchemy.run/domain"
import * as Model from "@alchemy.run/domain/Model"
import { CredentialListingLive } from "@checkfu/domain/Vault/CredentialListing.projection"
import { ListCredentialsLive } from "@checkfu/domain/Vault/ListCredentials.query"
import { ListVaultsLive } from "@checkfu/domain/Vault/ListVaults.query"
import { RetireReleasedCredentials } from "@checkfu/domain/Vault/RetireReleasedCredentials.policy"
import { SettleCredentialSecret } from "@checkfu/domain/Vault/SettleCredentialSecret.policy"
import { VaultListingLive } from "@checkfu/domain/Vault/VaultListing.projection"
import { Vaults, VaultsHandlersLive } from "@checkfu/domain/Vaults.model"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import {
	ConnectionCallFailed,
	CredentialSecretsLive,
	makeConnectionExecutorLayer,
} from "../../src/Connection/CredentialCustody.ts"
import { makeSecretCustody } from "../../src/Connection/SecretCustody.ts"
import { vaultListingQueriesFrom } from "../../src/Http/Listing.ts"
import type { SecretCustody } from "../../src/Connection/SecretCustody.ts"
import { makeCustodyDatabase } from "./CustodyDatabase.ts"
import type { CustodyRows } from "./CustodyDatabase.ts"

interface InMemoryConnection {
	readonly custody: SecretCustody
	readonly database: ReturnType<typeof makeCustodyDatabase>
}

const NOTHING: CustodyRows = { secrets: [], tombstones: [], sealed: false }

const StalledPoliciesLive = Layer.mergeAll(
	RetireReleasedCredentials.toLayer(Effect.succeed(() => Effect.never)),
	SettleCredentialSecret.toLayer(Effect.succeed(() => Effect.never)),
	VaultListingLive,
	ListVaultsLive,
	CredentialListingLive,
	ListCredentialsLive,
)

export const makeVaultsTestLayer = (options: { readonly policies?: "stalled" } = {}) => {
	const connections = new Map<string, InMemoryConnection>()
	const vaultOf = new Map<string, string>()
	const unreachable = new Set<string>()
	const eraseBlocked = new Set<string>()
	const calls: Array<{
		readonly operation: string
		readonly vaultId: string
		readonly credentialId: string | null
	}> = []

	const open = (vaultId: string): InMemoryConnection => {
		const existing = connections.get(vaultId)
		if (existing !== undefined) {
			return existing
		}
		const database = makeCustodyDatabase()
		const connection: InMemoryConnection = {
			database,
			custody: makeSecretCustody(database.sql),
		}
		connections.set(vaultId, connection)
		return connection
	}

	const call = <A>(
		operation: string,
		vaultId: string,
		credentialId: string | null,
		run: (custody: SecretCustody) => A | Promise<A>,
	): Effect.Effect<A, ConnectionCallFailed> =>
		Effect.suspend(() => {
			calls.push({ operation, vaultId, credentialId })
			if (credentialId !== null) {
				vaultOf.set(credentialId, vaultId)
			}
			return unreachable.has(vaultId)
				? Effect.fail(new ConnectionCallFailed({ cause: "unreachable in test" }))
				: Effect.promise(async () => run(open(vaultId).custody))
		})

	const databaseOf = (credentialId: string) => {
		const vaultId = vaultOf.get(credentialId)
		return vaultId === undefined ? undefined : open(vaultId).database
	}
	const read = (credentialId: string) => {
		const vaultId = vaultOf.get(credentialId)
		return vaultId === undefined ? null : open(vaultId).custody.read(credentialId)
	}

	const handlers = options.policies === "stalled" ? StalledPoliciesLive : VaultsHandlersLive
	const model = Vaults.layer(handlers.pipe(Layer.provide(ListingStore.memory))).pipe(
		Layer.provideMerge(CredentialSecretsLive),
		Layer.provideMerge(
			makeConnectionExecutorLayer({
				put: (vaultId, id, secret, target, mode) =>
					call(mode === "create" ? "put" : "replace", vaultId, id, (custody) =>
						custody.put(id, secret, target, mode),
					),
				erase: (vaultId, id) =>
					eraseBlocked.has(id)
						? Effect.fail(new ConnectionCallFailed({ cause: "erase blocked in test" }))
						: call("erase", vaultId, id, (custody) => custody.erase(id)),
				seal: (vaultId) => call("seal", vaultId, null, (custody) => custody.seal()),
				usable: (vaultId, id) => call("usable", vaultId, id, (custody) => custody.usable(id)),
			}),
		),
		Layer.provide(Domain.InMemory),
	)

	let internals: Model.Internals["Service"] | undefined
	const layer = Layer.mergeAll(
		model,
		vaultListingQueriesFrom(model),
		Layer.effectDiscard(
			Effect.map(Model.Internals, (found) => {
				internals = found
			}),
		).pipe(Layer.provide(model)),
	)

	return {
		layer,
		calls,
		unreachable,
		eraseBlocked,
		storedEvents: (aggregate: "Vault" | "Credential" | "CredentialUrlClaim", id: string) =>
			Effect.suspend(() => {
				const read = internals?.aggregates.get(aggregate)?.events
				return read === undefined
					? Effect.die(new Error(`no stored events for ${aggregate}`))
					: read(id)
			}),
		secretOf: (credentialId: string): string | null => read(credentialId)?.secret.token ?? null,
		targetOf: (credentialId: string): string | null => read(credentialId)?.target ?? null,
		rowsOf: (credentialId: string): CustodyRows => databaseOf(credentialId)?.rows() ?? NOTHING,
		storedWith: (credentialId: string): string => databaseOf(credentialId)?.stored() ?? "",
		custodyOf: (vaultId: string): SecretCustody => open(vaultId).custody,
		erased: (credentialId: string): boolean => {
			const rows = databaseOf(credentialId)?.rows() ?? NOTHING
			return (
				(rows.sealed || rows.tombstones.includes(credentialId)) &&
				!rows.secrets.includes(credentialId)
			)
		},
	}
}

export const VaultsTestLive = makeVaultsTestLayer().layer
