import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Effect from "effect/Effect"
import { COMPATIBILITY_DATE, TRACE_SAMPLING_RATE } from "../Compatibility.ts"
import { placedStub, placement } from "../Placement.ts"
import { PiHarnessWorker, TURN_CODE_UPDATE_STRATEGY } from "./PiHarness.ts"
import { piHarnessAiBindingProps } from "./PiModels.ts"
import { PiSession, PiSessionLive } from "./PiSession.do.ts"

export const PI_HARNESS_WORKER_PROPS = {
	main: import.meta.url,
	compatibility: { date: COMPATIBILITY_DATE },
	workersDev: false,
	codeUpdateStrategy: TURN_CODE_UPDATE_STRATEGY,
	observability: {
		enabled: true,
		issues: { enabled: true },
	},
	dev: { port: 1339 },
} satisfies Cloudflare.WorkerProps

export default PiHarnessWorker.make(
	Effect.map(piHarnessAiBindingProps, (aiProps) => ({ ...PI_HARNESS_WORKER_PROPS, ...aiProps })),
	Effect.gen(function* () {
		const piSession = placedStub(yield* PiSession, yield* placement)
		return PiHarnessWorker.of({
			recoverTurn: (conversation, operationId) =>
				Effect.orDie(piSession(conversation).recoverTurn(operationId)),
			runTurn: (conversation, request) => Effect.orDie(piSession(conversation).runTurn(request)),
			abortTurn: (conversation, operationId) =>
				Effect.orDie(piSession(conversation).abortTurn(operationId)),
		})
	}).pipe(
		Effect.provide([
			PiSessionLive,
			Cloudflare.Telemetry({ headSamplingRate: TRACE_SAMPLING_RATE }),
		]),
	),
)
