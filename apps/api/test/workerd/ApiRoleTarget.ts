import * as Cloudflare from "@alchemy.run/cloudflare"
import { RuntimeContext } from "alchemy/RuntimeContext"
import * as Effect from "effect/Effect"
import { calledBy } from "../../src/Api.ts"
import type { ApiShape } from "../../src/Api.ts"
import { COMPATIBILITY_DATE } from "../../src/Compatibility.ts"

export type RoleProbe = Pick<ApiShape, "credentialAccess" | "resolvePublication">

export class ApiRoleTarget extends Cloudflare.Worker<ApiRoleTarget, RoleProbe>()("ApiRoleTarget") {}

export default ApiRoleTarget.make(
	{ main: import.meta.url, compatibility: { date: COMPATIBILITY_DATE } },
	Effect.gen(function* () {
		const runtime = yield* Cloudflare.Worker
		return ApiRoleTarget.of({
			credentialAccess: () =>
				calledBy("harness")(Effect.succeed("held" as const)).pipe(
					Effect.provideService(RuntimeContext, runtime),
				),
			resolvePublication: () =>
				calledBy("content")(Effect.succeed(null)).pipe(
					Effect.provideService(RuntimeContext, runtime),
				),
		})
	}),
)
