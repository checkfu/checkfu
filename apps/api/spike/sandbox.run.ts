import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Alchemy from "alchemy"
import * as Effect from "effect/Effect"
import SandboxSpikeWorkerLive, { SandboxSpikeWorker } from "./SandboxSpikeWorker.ts"

// `alchemy dev apps/api/spike/sandbox.run.ts`: a stack of its own, so the product's stack needs
// no container runtime.
export default Alchemy.Stack(
	"CheckfuSandboxSpike",
	{ providers: Cloudflare.providers(), state: Alchemy.localState() },
	Effect.gen(function* () {
		const worker = yield* SandboxSpikeWorker
		return { url: worker.url.as<string>() }
	}).pipe(Effect.provide(SandboxSpikeWorkerLive)),
)
