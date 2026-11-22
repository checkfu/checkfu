import * as Effect from "effect/Effect"
import { requireShippedBaseline } from "./Lock.ts"

await Effect.runPromise(requireShippedBaseline)
