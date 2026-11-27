import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Alchemy from "alchemy"
import * as Effect from "effect/Effect"
import FanoutTestWorkerLive, { FanoutTestWorker } from "./WebhookFanoutFixture.ts"

export default Alchemy.Stack(
	"WebhookFanoutFixture",
	{ providers: Cloudflare.providers(), state: Alchemy.localState() },
	Effect.gen(function* () {
		const worker = yield* FanoutTestWorker
		return { url: worker.url }
	}).pipe(Effect.provide(FanoutTestWorkerLive)),
)
