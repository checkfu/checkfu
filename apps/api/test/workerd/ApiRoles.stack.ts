import * as Cloudflare from "@alchemy.run/cloudflare"
import { providers as domainProviders } from "@alchemy.run/domain/Cloudflare"
import * as Alchemy from "alchemy"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { publishDomainOnlyWhenRouted } from "../../../../alchemy.run.ts"
import ApiWorkerLive from "../../src/ApiWorker.ts"
import ContentWorkerLive from "../../src/Content/ContentWorker.ts"
import { customDomains } from "../../src/CustomDomain.ts"
import PiHarnessWorkerLive from "../../src/Pi/PiHarnessWorker.ts"
import ApiRoleCallerLive, { ApiRoleCaller } from "./ApiRoleCaller.ts"

export default Alchemy.Stack(
	"ApiRoles",
	{
		providers: Layer.mergeAll(Cloudflare.providers(), domainProviders()),
		state: Alchemy.localState(),
	},
	Effect.gen(function* () {
		const worker = yield* ApiRoleCaller
		return { url: worker.url }
	}).pipe(
		Effect.provide([ApiRoleCallerLive, ApiWorkerLive, ContentWorkerLive, PiHarnessWorkerLive]),
		publishDomainOnlyWhenRouted,
		(stack) => Effect.andThen(customDomains, stack),
	),
)
