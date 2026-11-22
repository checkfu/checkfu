import * as Context from "effect/Context"
import * as Effect from "effect/Effect"

export interface SigintController {
	readonly register: (handler: () => boolean) => () => void
	readonly handleSigint: () => boolean
}

export const makeSigintController = (): SigintController => {
	const handlers: Array<() => boolean> = []
	return {
		register: (handler) => {
			handlers.push(handler)
			return () => {
				const idx = handlers.lastIndexOf(handler)
				if (idx !== -1) handlers.splice(idx, 1)
			}
		},
		handleSigint: () => {
			for (let i = handlers.length - 1; i >= 0; i--) {
				const handler = handlers[i]
				if (handler !== undefined && handler()) {
					return true
				}
			}
			return false
		},
	}
}

export const SigintCoordinator = Context.Reference<SigintController>(
	"@checkfu/cli/SigintCoordinator",
	{
		defaultValue: makeSigintController,
	},
)

export const withSigintHandler = <A, E, R>(
	handler: () => boolean,
	effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
	Effect.scoped(
		Effect.gen(function* () {
			const coordinator = yield* SigintCoordinator
			yield* Effect.acquireRelease(
				Effect.sync(() => coordinator.register(handler)),
				(unregister) => Effect.sync(unregister),
			)
			return yield* effect
		}),
	)
