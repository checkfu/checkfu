import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Alchemy from "alchemy"
import * as Effect from "effect/Effect"
import ArtifactMountTestWorkerLive, { ArtifactMountTestWorker } from "./ArtifactMountFixture.ts"

export default Alchemy.Stack(
	"ArtifactMountFixture",
	{ providers: Cloudflare.providers(), state: Alchemy.localState() },
	Effect.gen(function* () {
		const worker = yield* ArtifactMountTestWorker
		return { url: worker.url }
	}).pipe(Effect.provide(ArtifactMountTestWorkerLive)),
)
