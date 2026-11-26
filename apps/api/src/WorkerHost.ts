import type { Dependencies } from "alchemy/Dependencies"
import type * as Effect from "effect/Effect"

export const hostOf = <Hosted, Host extends Effect.Effect<unknown, never, unknown>>(
	host: Host,
): Host & Effect.Effect<Dependencies<Hosted>, never, Effect.Services<Host>> =>
	host as Host & Effect.Effect<Dependencies<Hosted>, never, Effect.Services<Host>>
