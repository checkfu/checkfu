import * as Cloudflare from "@alchemy.run/cloudflare"
import { Vaults, VaultsHandlersLive } from "@checkfu/domain/Vaults.model"
import * as Alchemy from "alchemy"
import * as Cause from "effect/Cause"
import * as Digest from "effect/crypto/Digest"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Scope from "effect/Scope"
import { Checkfu, CheckfuHandlersLive } from "@checkfu/domain/Checkfu.model"
import {
	ConnectionCallFailed,
	ConnectionExecutor,
	CredentialSecretsLive,
} from "./Connection/CredentialCustody.ts"
import { customDomains } from "./CustomDomain.ts"
import { HealthTracerDisabledWhen, makeApiHandler } from "./Http/Router.ts"
import { PiDurableHarnessLive, PiTurnExecutor, harnessCall } from "./Pi/PiDurableHarness.ts"
import { PiHarnessWorker, TURN_CODE_UPDATE_STRATEGY } from "./Pi/PiHarness.ts"
import { PlacedDurableObjects } from "./PlacedDurableObjects.ts"

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
			abortTurn: (conversation, operationId) =>
				harnessCall(Effect.suspend(() => harness.abortTurn(conversation, operationId))).pipe(
					Effect.asVoid,
					Effect.withSpan("PiHarness.abortTurn"),
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

// Connection objects live in the harness Worker, next to the sessions that use them; the API
// reaches them through its calls.
const ConnectionExecutorLive = Layer.effect(
	ConnectionExecutor,
	Effect.gen(function* () {
		const harness = yield* Cloudflare.Workers.bindWorker(PiHarnessWorker)
		return {
			storeSecret: (credentialId, secret) =>
				connectionCall(Effect.suspend(() => harness.storeSecret(credentialId, secret))).pipe(
					Effect.withSpan("Connection.storeSecret"),
				),
			replaceSecret: (credentialId, secret) =>
				connectionCall(Effect.suspend(() => harness.replaceSecret(credentialId, secret))).pipe(
					Effect.withSpan("Connection.replaceSecret"),
				),
			keepSecret: (credentialId) =>
				connectionCall(Effect.suspend(() => harness.keepSecret(credentialId))).pipe(
					Effect.withSpan("Connection.keepSecret"),
				),
			erase: (credentialId) =>
				connectionCall(Effect.suspend(() => harness.eraseSecret(credentialId))).pipe(
					Effect.withSpan("Connection.erase"),
				),
		}
	}),
)

const CheckfuLive = Checkfu.layer(
	CheckfuHandlersLive.pipe(Layer.provide(PiDurableHarnessLive)),
).pipe(Layer.provide(PiHarnessExecutorLive), Layer.provide(PlacedDurableObjects))

const VaultsLive = Vaults.layer(VaultsHandlersLive).pipe(
	Layer.provideMerge(CredentialSecretsLive),
	Layer.provide(ConnectionExecutorLive),
	Layer.provide(PlacedDurableObjects),
)

const ApiWorkerLive = Layer.mergeAll(
	CheckfuLive,
	VaultsLive,
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
