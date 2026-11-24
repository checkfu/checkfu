import * as Cloudflare from "@alchemy.run/cloudflare"
import { Vaults, VaultsHandlersLive } from "@checkfu/domain/Vaults.model"
import * as Alchemy from "alchemy"
import * as Cause from "effect/Cause"
import * as Digest from "effect/crypto/Digest"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import type * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import { Checkfu, CheckfuHandlersLive } from "@checkfu/domain/Checkfu.model"
import { Connection } from "./Connection/Connection.ts"
import { ConnectionWorker } from "./Connection/ConnectionHost.ts"
import {
	ConnectionCallFailed,
	ConnectionExecutor,
	CredentialSecretsLive,
} from "./Connection/CredentialCustody.ts"
import { customDomains } from "./CustomDomain.ts"
import { HealthTracerDisabledWhen, makeApiHandler } from "./Http/Router.ts"
import { ApiCatalog } from "./OpenApi/ApiCatalog.ts"
import { ApiCatalogCallFailed, ApiCatalogExecutor } from "./OpenApi/ApiCatalogExecutor.ts"
import { ApiCatalogsLive } from "./OpenApi/ApiCatalogKeeper.ts"
import { ApiSpecCheck } from "./OpenApi/ApiSpecCheck.ts"
import type { ApiSpecSelection } from "./OpenApi/ApiSpecCheck.ts"
import { PiDurableHarnessLive, PiTurnExecutor, harnessCall } from "./Pi/PiDurableHarness.ts"
import { PiHarnessWorker, TURN_CODE_UPDATE_STRATEGY } from "./Pi/PiHarness.ts"
import { PlacedDurableObjects } from "./PlacedDurableObjects.ts"
import { placedStub, placement } from "./Placement.ts"
import { ToolSchemaCheck } from "./Pi/PiToolSchemaCheck.ts"

const PiHarnessExecutorLive = Layer.effect(
	PiTurnExecutor,
	Effect.gen(function* () {
		const harness = yield* Cloudflare.Workers.bindWorker(PiHarnessWorker)
		return {
			recoverTurn: (conversation, operationId) =>
				harnessCall(Effect.suspend(() => harness.recoverTurn(conversation, operationId))).pipe(
					Effect.withSpan("PiHarness.recoverTurn"),
				),
			runTurn: (conversation, request) =>
				harnessCall(Effect.suspend(() => harness.runTurn(conversation, request))).pipe(
					Effect.withSpan("PiHarness.runTurn"),
				),
			resumeTurn: (conversation, operationId, decisions) =>
				harnessCall(
					Effect.suspend(() => harness.resumeTurn(conversation, operationId, decisions)),
				).pipe(Effect.withSpan("PiHarness.resumeTurn")),
			abortTurn: (conversation, operationId) =>
				harnessCall(Effect.suspend(() => harness.abortTurn(conversation, operationId))).pipe(
					Effect.asVoid,
					Effect.withSpan("PiHarness.abortTurn"),
				),
			waitingCalls: (conversation) =>
				harnessCall(Effect.suspend(() => harness.waitingCalls(conversation))).pipe(
					Effect.withSpan("PiHarness.waitingCalls"),
				),
			cancelWaiting: (conversation, operationId) =>
				harnessCall(Effect.suspend(() => harness.cancelWaiting(conversation, operationId))).pipe(
					Effect.withSpan("PiHarness.cancelWaiting"),
				),
			discardWorkspace: (sessionId) =>
				harnessCall(Effect.suspend(() => harness.discardWorkspace(sessionId))).pipe(
					Effect.withSpan("PiHarness.discardWorkspace"),
				),
		}
	}),
)

const connectionCall = <A, E, R>(
	call: Effect.Effect<A, E, R>,
): Effect.Effect<A, ConnectionCallFailed, R> =>
	Effect.catchCause(call, (cause): Effect.Effect<never, ConnectionCallFailed> =>
		Cause.hasInterruptsOnly(cause)
			? Effect.interrupt
			: Effect.fail(new ConnectionCallFailed({ cause })),
	)

// The API reaches each credential's connection object in the connection Worker directly.
const ConnectionExecutorLive = Layer.effect(
	ConnectionExecutor,
	Effect.gen(function* () {
		const connection = placedStub(
			yield* Connection.from(ConnectionWorker),
			yield* Effect.orDie(placement),
		)
		return {
			storeSecret: (credentialId, secret, target) =>
				connectionCall(
					Effect.suspend(() => connection(credentialId).storeSecret(secret, target)),
				).pipe(Effect.withSpan("Connection.storeSecret")),
			replaceSecret: (credentialId, secret) =>
				connectionCall(Effect.suspend(() => connection(credentialId).replaceSecret(secret))).pipe(
					Effect.withSpan("Connection.replaceSecret"),
				),
			keepSecret: (credentialId) =>
				connectionCall(Effect.suspend(() => connection(credentialId).keepSecret())).pipe(
					Effect.withSpan("Connection.keepSecret"),
				),
			erase: (credentialId) =>
				connectionCall(Effect.suspend(() => connection(credentialId).erase())).pipe(
					Effect.withSpan("Connection.erase"),
				),
			refreshReport: (credentialId) =>
				connectionCall(Effect.suspend(() => connection(credentialId).refreshReport())).pipe(
					Effect.withSpan("Connection.refreshReport"),
				),
			acknowledgeRefresh: (credentialId, refreshes) =>
				connectionCall(
					Effect.suspend(() => connection(credentialId).acknowledgeRefresh(refreshes)),
				).pipe(Effect.withSpan("Connection.acknowledgeRefresh")),
		}
	}),
)

const ToolSchemaCheckLive = Layer.effect(
	ToolSchemaCheck,
	Effect.gen(function* () {
		const harness = yield* Cloudflare.Workers.bindWorker(PiHarnessWorker)
		return {
			checkable: (schemas: ReadonlyArray<Schema.JsonObject>) =>
				harnessCall(Effect.suspend(() => harness.checkToolSchemas(schemas))).pipe(
					Effect.withSpan("PiHarness.checkToolSchemas"),
					// An unreachable harness can say nothing about a schema; the write fails and is sent again.
					Effect.orDie,
				),
		}
	}),
)

const catalogCall = <A, E, R>(
	call: Effect.Effect<A, E, R>,
): Effect.Effect<A, ApiCatalogCallFailed, R> =>
	Effect.catchCause(call, (cause): Effect.Effect<never, ApiCatalogCallFailed> =>
		Cause.hasInterruptsOnly(cause)
			? Effect.interrupt
			: Effect.fail(new ApiCatalogCallFailed({ cause })),
	)

const ApiCatalogExecutorLive = Layer.effect(
	ApiCatalogExecutor,
	Effect.gen(function* () {
		const catalog = placedStub(
			yield* ApiCatalog.from(ConnectionWorker),
			yield* Effect.orDie(placement),
		)
		return {
			store: (catalogId, document, config) =>
				catalogCall(Effect.suspend(() => catalog(catalogId).store(document, config))).pipe(
					Effect.withSpan("ApiCatalog.store"),
				),
			keep: (catalogId) =>
				catalogCall(Effect.suspend(() => catalog(catalogId).keep())).pipe(
					Effect.withSpan("ApiCatalog.keep"),
				),
		}
	}),
)

const ApiSpecCheckLive = Layer.effect(
	ApiSpecCheck,
	Effect.gen(function* () {
		const harness = yield* Cloudflare.Workers.bindWorker(PiHarnessWorker)
		return {
			check: (document: string, selection: ApiSpecSelection) =>
				harnessCall(Effect.suspend(() => harness.checkApiSpec(document, selection))).pipe(
					Effect.withSpan("PiHarness.checkApiSpec"),
					// An unreachable harness can say nothing about a document; the write fails and is sent again.
					Effect.orDie,
				),
		}
	}),
)

const CheckfuLive = Checkfu.layer(
	CheckfuHandlersLive.pipe(Layer.provide(PiDurableHarnessLive)),
).pipe(Layer.provide(PiHarnessExecutorLive), Layer.provide(PlacedDurableObjects))

const VaultsLive = Vaults.layer(VaultsHandlersLive).pipe(
	Layer.provideMerge(CredentialSecretsLive),
	Layer.provideMerge(Layer.provide(ApiCatalogsLive, ApiCatalogExecutorLive)),
	// The API's handlers and a session's turn also ask the connections for refresh outcomes.
	Layer.provideMerge(ConnectionExecutorLive),
	Layer.provide(PlacedDurableObjects),
)

// A session's turn reads the servers it bound, which the vault model records.
const ApiWorkerLive = Layer.mergeAll(
	CheckfuLive.pipe(Layer.provideMerge(VaultsLive)),
	ToolSchemaCheckLive,
	ApiSpecCheckLive,
	ApiCatalogExecutorLive,
	Cloudflare.Telemetry({ headSamplingRate: 0.1 }),
	Alchemy.Telemetry.layer(HealthTracerDisabledWhen),
	Digest.layerWebCrypto,
).pipe(Layer.provideMerge(SecureRandom.layerWebCrypto))

export const API_WORKER_PROPS = {
	main: import.meta.url,
	compatibility: {
		// >= 2026-11-17 enables request.signal by default so Effect fetch handlers
		// and SSE polling streams interrupt cleanly when clients disconnect.
		date: "2026-11-17",
	},
	codeUpdateStrategy: TURN_CODE_UPDATE_STRATEGY,
	observability: {
		// Keep top-level Workers Observability enabled when adding `issues`, since
		// providing `observability` bypasses Alchemy's DEFAULT_OBSERVABILITY fallback.
		enabled: true,
		issues: { enabled: true },
	},
} satisfies Cloudflare.WorkerProps

export default class ApiWorker extends Cloudflare.Worker<ApiWorker>()(
	"ApiWorker",
	Effect.map(customDomains, ({ api }) => ({ ...API_WORKER_PROPS, ...api })),
	Effect.gen(function* () {
		// Platform pins the owning instance/build Scope onto the Worker init context.
		// Building both the domain/telemetry layers and the HTTP router in that scope
		// keeps them alive across requests and runs their finalizers when disposed.
		const scope = Option.getOrUndefined(yield* Effect.serviceOption(Scope.Scope))
		if (scope === undefined) {
			return yield* Effect.die(new Error("ApiWorker requires an owning instance Scope."))
		}
		const services = yield* Layer.buildWithScope(ApiWorkerLive, scope)
		return yield* makeApiHandler.pipe(Scope.provide(scope), Effect.provide(services))
	}),
) {}
