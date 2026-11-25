import * as Alchemy from "alchemy"
import * as Effect from "effect/Effect"

export const PRODUCTION_STAGE = "production"

/**
 * Applied to the whole stack. On the production stage, any plan that would delete or replace
 * one of its resources fails before anything is applied, including `alchemy destroy`. The
 * policy is kept in state, so deleting production on purpose takes two deploys: one without
 * this, then the destroy. It does not cover a Durable Object class: a Worker update that
 * removes the last binding for a class deletes it and every object in it, which the plan shows
 * only as an `unbind`.
 */
export const protectInProduction = Alchemy.RemovalPolicy.protect(
	Effect.map(Effect.service(Alchemy.Stage), (stage) => stage === PRODUCTION_STAGE),
)
