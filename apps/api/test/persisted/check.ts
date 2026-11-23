import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Runtime from "effect/Runtime"
import { PersistedServicesLive, checkShippedBaseline } from "./Lock.ts"

const main = () => {
	BunRuntime.runMain(
		checkShippedBaseline.pipe(
			Effect.catch((error) =>
				Console.error(error.message).pipe(
					Effect.andThen(Effect.fail({ [Runtime.errorReported]: false })),
				),
			),
			Effect.provide(PersistedServicesLive),
		),
	)
}

main()
