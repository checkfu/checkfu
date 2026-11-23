import * as Cloudflare from "@alchemy.run/cloudflare"
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare"
import ApiWorker from "@checkfu/api/ApiWorker"
import * as Alchemy from "alchemy"
import * as Provider from "alchemy/Provider"
import * as State from "alchemy/State/State"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Tracer from "effect/Tracer"

export const DEFAULT_STATE_STORE_WORKER_NAME = "alchemy-state-store" as const

/**
 * Observability settings for the Cloudflare state-store Worker.
 * `Cloudflare.state()` applies this when bootstrapping or upgrading the store;
 * existing current-version stores can be updated once with
 * `bun run state:sync-observability`.
 */
export const CLOUDFLARE_STATE_OBSERVABILITY = {
	enabled: true,
	logs: { enabled: true, invocationLogs: false },
} as const

const rawState = Layer.unwrap(
	Effect.map(Alchemy.AlchemyContext, (ctx) =>
		ctx.dev
			? Alchemy.localState()
			: Cloudflare.state({
					observability: CLOUDFLARE_STATE_OBSERVABILITY,
				}),
	),
)

export const shouldRequireShippedBaseline = Effect.gen(function* () {
	const ctx = yield* Alchemy.AlchemyContext
	return !ctx.dev && (yield* Alchemy.Stage) === "production"
})

const evaluatedDeployStacks = new WeakSet<object>()

const isDeployBuildForStack = (stack: Option.Option<Alchemy.Stack["Service"]>): boolean =>
	Option.isSome(stack) &&
	(evaluatedDeployStacks.has(stack.value) ||
		Object.keys(stack.value.resources).length > 0 ||
		Object.keys(stack.value.actions).length > 0)

const hasAncestorSpan = (name: string) =>
	Effect.map(Effect.serviceOption(Tracer.ParentSpan), (initial) => {
		let current: Option.Option<Tracer.AnySpan> = initial
		while (Option.isSome(current)) {
			const span = current.value
			if (span._tag !== "Span") {
				return false
			}
			if (span.name === name) {
				return true
			}
			current = span.parent
		}
		return false
	})

/**
 * Records that the stack program executed for the current `Alchemy.Stack` build.
 * Deploy builds (`Alchemist.plan({ operation: "deploy" })` / `Deploy.deploy`)
 * evaluate the stack program; standalone `destroy` uses `buildWithoutProgram`,
 * leaving the stack unmarked and empty so production destroys stay unblocked
 * while delete-first replacements during a deploy are still gated.
 */
export const markDeployProgramEvaluated = Effect.gen(function* () {
	const stack = yield* Effect.serviceOption(Alchemy.Stack)
	if (Option.isSome(stack)) {
		evaluatedDeployStacks.add(stack.value)
	}
})

const isProductionDeployStateInit = (stack: Option.Option<Alchemy.Stack["Service"]>) =>
	Effect.gen(function* () {
		if (yield* hasAncestorSpan("cli.deploy")) {
			return true
		}
		return isDeployBuildForStack(stack) && (yield* hasAncestorSpan("plan.make"))
	})

const guardProviderService = (
	service: Provider.ProviderService,
	gate: Effect.Effect<void>,
	isDeployBuild: () => boolean,
): Provider.ProviderService => ({
	...service,
	...(service.precreate === undefined
		? {}
		: {
				precreate: (input) =>
					Effect.andThen(gate, () =>
						service.precreate === undefined
							? Effect.die("Provider precreate unexpectedly unavailable")
							: service.precreate(input),
					),
			}),
	reconcile: (input) => Effect.andThen(gate, () => service.reconcile(input)),
	delete: (input) =>
		Effect.andThen(
			Effect.gen(function* () {
				if (isDeployBuild() || (yield* hasAncestorSpan("cli.deploy"))) {
					yield* gate
				}
			}),
			() => service.delete(input),
		),
	...(service.modes === undefined
		? {}
		: {
				modes: {
					live: Effect.map(service.modes.live, (live) =>
						guardProviderService(live, gate, isDeployBuild),
					),
					local: Effect.map(service.modes.local, (local) =>
						guardProviderService(local, gate, isDeployBuild),
					),
				},
			}),
})

/**
 * Enforces the shipped-baseline gate before the first mutation of a production
 * deploy (`precreate`, `reconcile`, or deploy-triggered `delete` such as a
 * delete-first replacement or orphan cleanup) rather than stack evaluation, so
 * read-only production commands (`alchemy logs --stage production`), standalone
 * `destroy`, and local dev continue working while any production deploy is
 * refused before touching live resources until the persisted lock is cut and
 * committed.
 */
export const withProductionBaselineGate = <ROut, E, RIn>(
	providers: Layer.Layer<ROut, E, RIn>,
	gate: Effect.Effect<void>,
): Layer.Layer<ROut, E, RIn | Alchemy.AlchemyContext | Alchemy.Stage> =>
	Layer.effectContext(
		Effect.gen(function* () {
			const built = yield* Layer.build(providers)
			if (!(yield* shouldRequireShippedBaseline)) {
				return built
			}
			const stack = yield* Effect.serviceOption(Alchemy.Stack)
			const isDeployBuild = (): boolean => isDeployBuildForStack(stack)
			const checkOnce = yield* Effect.cached(gate)
			const map = new Map<string, unknown>()
			for (const [key, value] of built.mapUnsafe.entries()) {
				if (Provider.isProviderCollectionService(value)) {
					const wrappedProviders = Object.fromEntries(
						Object.entries(value.providers).map(([type, service]) => [
							type,
							guardProviderService(service, checkOnce, isDeployBuild),
						]),
					)
					map.set(key, {
						...value,
						get: (service: string) => wrappedProviders[service],
						providers: wrappedProviders,
					})
				} else if (Provider.isProviderService(value)) {
					map.set(key, guardProviderService(value, checkOnce, isDeployBuild))
				} else {
					map.set(key, value)
				}
			}
			return Context.makeUnsafe<ROut>(map)
		}),
	)

/**
 * Guards production state-store initialization during production deploys
 * (`cli.deploy` — including its `--detect-drift` preflight — and programmatic
 * `plan.make` deploy planning) so a missing or outdated Cloudflare state-store
 * Worker cannot be bootstrapped or upgraded before the persisted compatibility
 * baseline passes, while leaving `alchemy logs`, standalone `drift`, standalone
 * `destroy`, local dev, and non-production stages unaffected.
 */
export const withProductionStateGate = <E, RIn>(
	stateLayer: Layer.Layer<State.State, E, RIn>,
	gate: Effect.Effect<void>,
): Layer.Layer<State.State, E, RIn | Alchemy.AlchemyContext | Alchemy.Stage> =>
	Layer.effect(
		State.State,
		Effect.all({
			stateInit: State.State,
			requireBaseline: shouldRequireShippedBaseline,
			stack: Effect.serviceOption(Alchemy.Stack),
			checkOnce: Effect.cached(gate),
		}).pipe(
			Effect.map(({ stateInit, requireBaseline, stack, checkOnce }) =>
				requireBaseline
					? Effect.gen(function* () {
							if (yield* isProductionDeployStateInit(stack)) {
								yield* checkOnce
							}
							return yield* stateInit
						})
					: stateInit,
			),
		),
	).pipe(Layer.provide(stateLayer))

const runShippedBaselineGate = Effect.gen(function* () {
	const { requireShippedBaseline } = yield* Effect.promise(
		() => import("./apps/api/test/persisted/Lock.ts"),
	)
	yield* requireShippedBaseline
})

const state = withProductionStateGate(rawState, runShippedBaselineGate)

export default Alchemy.Stack(
	"Checkfu",
	{
		providers: withProductionBaselineGate(
			Layer.mergeAll(Cloudflare.providers(), DomainCloudflare.providers()),
			runShippedBaselineGate,
		),
		state,
	},
	Effect.gen(function* () {
		yield* markDeployProgramEvaluated
		const api = yield* ApiWorker
		return {
			api: api.url.as<string>(),
		}
	}),
)
