import * as Config from "effect/Config"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"

export const optionalSecret = (name: string): Config.Config<Redacted.Redacted<string> | null> =>
	Config.option(Config.Redacted(name)).pipe(
		Config.map(Option.filter((secret) => Redacted.value(secret).length > 0)),
		Config.map(Option.getOrNull),
	)
