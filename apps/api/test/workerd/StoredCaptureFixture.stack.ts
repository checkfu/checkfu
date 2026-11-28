import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Alchemy from "alchemy"
import * as Effect from "effect/Effect"
import StoredCaptureTestWorkerLive, { StoredCaptureTestWorker } from "./StoredCaptureFixture.ts"

export default Alchemy.Stack(
	"StoredCaptureFixture",
	{ providers: Cloudflare.providers(), state: Alchemy.localState() },
	Effect.gen(function* () {
		const worker = yield* StoredCaptureTestWorker
		return { url: worker.url }
	}).pipe(Effect.provide(StoredCaptureTestWorkerLive)),
)
