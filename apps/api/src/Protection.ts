import * as Alchemy from "alchemy"
import * as Effect from "effect/Effect"

export const PRODUCTION_STAGE = "production"

export const protectInProduction = Alchemy.RemovalPolicy.protect(
	Effect.map(Effect.service(Alchemy.Stage), (stage) => stage === PRODUCTION_STAGE),
)
