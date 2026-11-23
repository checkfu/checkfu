import { stdout } from "node:process"
import * as Alchemist from "alchemy/Alchemist"
import * as Effect from "effect/Effect"

// Prints the names of the Alchemy profiles that have a Cloudflare account connected,
// as a JSON array. `checkfu deploy` runs it in the checkout so the CLI itself never
// has to load Alchemy.
const profiles = await Effect.runPromise(
	Alchemist.Profile.list().pipe(Effect.provide(Alchemist.layer())),
)
stdout.write(
	JSON.stringify(
		profiles
			.filter((profile) => profile.providers.some((provider) => provider.name === "Cloudflare"))
			.map((profile) => profile.name),
	),
)
