import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Alchemy from "alchemy"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import ApiRoleCallerLive, { ApiRoleCaller } from "./ApiRoleCaller.ts"
import ApiRoleTargetLive from "./ApiRoleTarget.ts"

export default Alchemy.Stack(
	"ApiRoles",
	{ providers: Cloudflare.providers(), state: Alchemy.localState() },
	Effect.gen(function* () {
		const worker = yield* ApiRoleCaller
		return { url: worker.url }
	}).pipe(Effect.provide(ApiRoleCallerLive.pipe(Layer.provide(ApiRoleTargetLive)))),
)
