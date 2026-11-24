import * as Domain from "@alchemy.run/domain"
import * as Model from "@alchemy.run/domain/Model"
import { KeepApiCatalogs, KeepApiCatalogsLive } from "@checkfu/domain/Mcp/KeepApiCatalogs.policy"
import { RetireReleasedCredentialLive } from "@checkfu/domain/Vault/RetireReleasedCredential.policy"
import { SettleCredentialSecretLive } from "@checkfu/domain/Vault/SettleCredentialSecret.policy"
import { Vaults } from "@checkfu/domain/Vaults.model"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schedule from "effect/Schedule"
import {
	ConnectionCallFailed,
	CredentialSecretsLive,
	makeConnectionExecutorLayer,
} from "../../src/Connection/CredentialCustody.ts"
import { makeSecretCustody } from "../../src/Connection/SecretCustody.ts"
import type { HeldSecret, SecretCustody } from "../../src/Connection/SecretCustody.ts"
import {
	ApiCatalogCallFailed,
	makeApiCatalogExecutorLayer,
} from "../../src/OpenApi/ApiCatalogExecutor.ts"
import { ApiCatalogsLive } from "../../src/OpenApi/ApiCatalogKeeper.ts"
import { makeApiCatalog } from "../../src/OpenApi/ApiCatalogStore.ts"
import type { ApiCatalogCustody } from "../../src/OpenApi/ApiCatalogStore.ts"

interface InMemoryConnection {
	readonly custody: SecretCustody
	readonly storage: Map<string, string>
	alarm: number | null
}

interface InMemoryCatalog {
	readonly custody: ApiCatalogCustody
	readonly kv: Map<string, string>
	alarm: number | null
}

/**
 * The connection and API catalog objects, in memory: the same custody rules
 * as the Durable Objects, over a map per credential or catalog.
 */
export const makeVaultsTestLayer = (platform: typeof Domain.InMemory = Domain.InMemory) => {
	const connections = new Map<string, InMemoryConnection>()
	const catalogs = new Map<string, InMemoryCatalog>()
	const unreachableCatalogs = new Set<string>()
	const unreachable = new Set<string>()
	const calls: Array<{ readonly operation: string; readonly credentialId: string }> = []
	let now = 0

	const open = (credentialId: string): InMemoryConnection => {
		const existing = connections.get(credentialId)
		if (existing !== undefined) {
			return existing
		}
		const storage = new Map<string, string>()
		const connection: InMemoryConnection = {
			storage,
			alarm: null,
			custody: makeSecretCustody(
				{
					get: (key) => storage.get(key),
					put: (key, value) => {
						storage.set(key, value)
					},
					clear: () => {
						storage.clear()
						return Promise.resolve()
					},
					setAlarm: (at) => {
						connection.alarm = at
						return Promise.resolve()
					},
					deleteAlarm: () => {
						connection.alarm = null
						return Promise.resolve()
					},
				},
				() => now,
			),
		}
		connections.set(credentialId, connection)
		return connection
	}

	const openCatalog = (catalogId: string): InMemoryCatalog => {
		const existing = catalogs.get(catalogId)
		if (existing !== undefined) {
			return existing
		}
		const kv = new Map<string, string>()
		const catalog: InMemoryCatalog = {
			kv,
			alarm: null,
			custody: makeApiCatalog(
				{
					get: (key) => kv.get(key),
					put: (key, value) => {
						kv.set(key, value)
					},
					clear: () => {
						kv.clear()
						return Promise.resolve()
					},
					setAlarm: (at) => {
						catalog.alarm = at
						return Promise.resolve()
					},
					deleteAlarm: () => {
						catalog.alarm = null
						return Promise.resolve()
					},
				},
				() => now,
			),
		}
		catalogs.set(catalogId, catalog)
		return catalog
	}

	const catalogCall = <A>(
		catalogId: string,
		run: (custody: ApiCatalogCustody) => Promise<A>,
	): Effect.Effect<A, ApiCatalogCallFailed> =>
		Effect.suspend(() =>
			unreachableCatalogs.has(catalogId) || unreachableCatalogs.has("*")
				? Effect.fail(new ApiCatalogCallFailed({ cause: "unreachable in test" }))
				: Effect.promise(() => run(openCatalog(catalogId).custody)),
		)

	const call = <A>(
		operation: string,
		credentialId: string,
		run: (custody: SecretCustody) => A | Promise<A>,
	): Effect.Effect<A, ConnectionCallFailed> =>
		Effect.suspend(() => {
			calls.push({ operation, credentialId })
			return unreachable.has(credentialId)
				? Effect.fail(new ConnectionCallFailed({ cause: "unreachable in test" }))
				: Effect.promise(async () => run(open(credentialId).custody))
		})

	// How many confirmations of a document fail before one succeeds, as an unreachable store would.
	const catalogKeepFailures = { remaining: 0 }
	const catalogExecutor = makeApiCatalogExecutorLayer({
		store: (id, document, config) => catalogCall(id, (custody) => custody.store(document, config)),
		keep: (id) =>
			catalogKeepFailures.remaining > 0
				? Effect.suspend(() => {
						catalogKeepFailures.remaining -= 1
						return Effect.fail(new ApiCatalogCallFailed({ cause: "unreachable in test" }))
					})
				: catalogCall(id, (custody) => custody.keep()),
	})

	// The hosted inbox delivers a failed policy row again; this in-memory host does not, so the
	// confirmation of a document is tried again here instead.
	const handlers = Layer.mergeAll(
		RetireReleasedCredentialLive,
		SettleCredentialSecretLive,
		KeepApiCatalogs.toLayer(KeepApiCatalogs, {
			retry: Schedule.spaced("10 millis").pipe(Schedule.upTo({ times: 5 })),
		}).pipe(Layer.provide(KeepApiCatalogsLive)),
	)
	const model = Vaults.layer(handlers).pipe(
		Layer.provideMerge(CredentialSecretsLive),
		Layer.provideMerge(Layer.provide(ApiCatalogsLive, catalogExecutor)),
		Layer.provideMerge(
			makeConnectionExecutorLayer({
				storeSecret: (id, secret, url) =>
					call("store", id, (custody) => custody.store(secret, url)),
				replaceSecret: (id, secret) => call("replace", id, (custody) => custody.replace(secret)),
				keepSecret: (id) => call("keep", id, (custody) => custody.keep()),
				erase: (id) => call("erase", id, (custody) => custody.erase()),
				refreshReport: (id) =>
					call("report", id, (custody) => (custody.unreported() ? custody.report() : null)),
				acknowledgeRefresh: (id, refreshes) =>
					call("acknowledge", id, (custody) => custody.reported(refreshes)),
			}),
		),
		Layer.provide(platform),
	)

	// Another model hosted beside this one has internals of its own, so keep these.
	let internals: Model.Internals["Service"] | undefined
	const layer = Layer.mergeAll(
		model,
		Layer.effectDiscard(
			Effect.map(Model.Internals, (found) => {
				internals = found
			}),
		).pipe(Layer.provide(model)),
		catalogExecutor,
	)

	return {
		layer,
		calls,
		unreachable,
		/** What the host stored for one instance, as it stored it. */
		storedEvents: (aggregate: "Vault" | "Credential" | "McpServerSet", id: string) =>
			Effect.suspend(() => {
				const read = internals?.aggregates.get(aggregate)?.events
				return read === undefined
					? Effect.die(new Error(`no stored events for ${aggregate}`))
					: read(id)
			}),
		/** The token the connection would send: a bearer token, or an OAuth access token. */
		secretOf: (credentialId: string): string | null => {
			const held = open(credentialId).custody.read()
			return held === null ? null : held.type === "mcp_oauth" ? held.access_token : held.token
		},
		held: (credentialId: string): HeldSecret | null => open(credentialId).custody.read(),
		custodyOf: (credentialId: string): SecretCustody => open(credentialId).custody,
		heldBy: (credentialId: string): ReadonlyMap<string, string> => open(credentialId).storage,
		unreachableCatalogs,
		catalogKeepFailures,
		catalogIds: (): ReadonlyArray<string> => [...catalogs.keys()],
		catalogOf: (catalogId: string): ApiCatalogCustody => openCatalog(catalogId).custody,
		catalogDocumentOf: (catalogId: string): string | null =>
			openCatalog(catalogId).kv.get("document") ?? null,
		catalogStatusOf: (catalogId: string): string | undefined =>
			openCatalog(catalogId).kv.get("status"),
		alarmOf: (credentialId: string): number | null => open(credentialId).alarm,
		/** Moves the clock to `at` and fires every alarm that is due, as the object's runtime would. */
		advanceTo: async (at: number): Promise<void> => {
			now = at
			for (const connection of connections.values()) {
				if (connection.alarm !== null && connection.alarm <= at) {
					connection.alarm = null
					await connection.custody.expire()
				}
			}
			for (const catalog of catalogs.values()) {
				if (catalog.alarm !== null && catalog.alarm <= at) {
					catalog.alarm = null
					await catalog.custody.expire()
				}
			}
		},
	}
}

export const VaultsTestLive = makeVaultsTestLayer().layer
