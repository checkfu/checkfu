import * as Domain from "@alchemy.run/domain"
import * as Model from "@alchemy.run/domain/Model"
import { Vaults, VaultsHandlersLive } from "@checkfu/domain/Vaults.model"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import {
	ConnectionCallFailed,
	CredentialSecretsLive,
	makeConnectionExecutorLayer,
} from "../../src/Connection/CredentialCustody.ts"
import { makeSecretCustody } from "../../src/Connection/SecretCustody.ts"
import type { SecretCustody } from "../../src/Connection/SecretCustody.ts"

interface InMemoryConnection {
	readonly custody: SecretCustody
	readonly storage: Map<string, string>
	alarm: number | null
}

/**
 * The connection objects, in memory: the same custody rules as the Durable
 * Object, over a map per credential.
 */
export const makeVaultsTestLayer = (platform: typeof Domain.InMemory = Domain.InMemory) => {
	const connections = new Map<string, InMemoryConnection>()
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

	const model = Vaults.layer(VaultsHandlersLive).pipe(
		Layer.provideMerge(CredentialSecretsLive),
		Layer.provide(
			makeConnectionExecutorLayer({
				storeSecret: (id, secret, url) =>
					call("store", id, (custody) => custody.store(secret, url)),
				replaceSecret: (id, secret) => call("replace", id, (custody) => custody.replace(secret)),
				keepSecret: (id) => call("keep", id, (custody) => custody.keep()),
				erase: (id) => call("erase", id, (custody) => custody.erase()),
			}),
		),
		Layer.provide(platform),
	)

	// Another model hosted beside this one has internals of its own, so keep these.
	let internals: Model.Internals["Service"] | undefined
	const layer = Layer.merge(
		model,
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
		/** What the host stored for one instance, as it stored it. */
		storedEvents: (aggregate: "Vault" | "Credential", id: string) =>
			Effect.suspend(() => {
				const read = internals?.aggregates.get(aggregate)?.events
				return read === undefined
					? Effect.die(new Error(`no stored events for ${aggregate}`))
					: read(id)
			}),
		secretOf: (credentialId: string): string | null => open(credentialId).custody.read(),
		heldBy: (credentialId: string): ReadonlyMap<string, string> => open(credentialId).storage,
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
		},
	}
}

export const VaultsTestLive = makeVaultsTestLayer().layer
