import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"

export const optionalSecret = (name: string) =>
	Config.option(Config.Redacted(name)).pipe(
		Effect.map(Option.filter((secret) => Redacted.value(secret).length > 0)),
		Effect.map(Option.getOrNull),
		Effect.orDie,
	)
