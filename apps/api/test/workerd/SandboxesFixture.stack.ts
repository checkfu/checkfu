import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Alchemy from "alchemy"
import * as Effect from "effect/Effect"
import SandboxesTestWorkerLive, { SandboxesTestWorker } from "./SandboxesFixture.ts"

export default Alchemy.Stack(
	"SandboxesFixture",
	{ providers: Cloudflare.providers(), state: Alchemy.localState() },
	Effect.gen(function* () {
		const worker = yield* SandboxesTestWorker
		return { url: worker.url }
	}).pipe(Effect.provide(SandboxesTestWorkerLive)),
)
