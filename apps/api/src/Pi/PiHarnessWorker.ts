import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { COMPATIBILITY_DATE, TRACE_SAMPLING_RATE } from "../Compatibility.ts"
import { placedStub, placement } from "../Placement.ts"
import { PiHarnessWorker, TURN_CODE_UPDATE_STRATEGY } from "./PiHarness.ts"
import { piHarnessAiBindingProps } from "./PiModels.ts"
import { SandboxesCloudflare, sandboxEgress } from "../Sandbox/CloudflareSandboxes.do.ts"
import { readSkill } from "../Skills/ReadSkill.ts"
import { SessionWorkspace, SessionWorkspaceLive } from "../Workspace/SessionWorkspace.do.ts"
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
		const where = yield* placement
		const piSession = placedStub(yield* PiSession, where)
		const workspace = placedStub(yield* SessionWorkspace, where)
		return PiHarnessWorker.of({
			recoverTurn: (conversation, operationId) =>
				Effect.orDie(piSession(conversation).recoverTurn(operationId)),
			runTurn: (conversation, request) => Effect.orDie(piSession(conversation).runTurn(request)),
			abortTurn: (conversation, operationId) =>
				Effect.orDie(piSession(conversation).abortTurn(operationId)),
			enterWorkspace: (sessionId, token) => Effect.orDie(workspace(sessionId).enter(token)),
			prepareWorkspace: (sessionId, token, repositories, allowedHosts) =>
				Effect.orDie(workspace(sessionId).prepare(token, repositories, allowedHosts)),
			storeRepositoryToken: (sessionId, resourceId, token, replace) =>
				Effect.orDie(workspace(sessionId).storeRepositoryToken(resourceId, token, replace)),
			interruptWorkspace: (sessionId, token) => Effect.orDie(workspace(sessionId).interrupt(token)),
			discardWorkspace: (sessionId) => Effect.orDie(workspace(sessionId).discard(sessionId)),
			readSkill: (markdown) => Effect.promise(() => readSkill(markdown)),
			fetch: yield* sandboxEgress((sessionId, request) =>
				Effect.orDie(workspace(sessionId).fetch(request)),
			),
		})
	}).pipe(
		Effect.provide([
			Layer.provideMerge(PiSessionLive, Layer.provide(SessionWorkspaceLive, SandboxesCloudflare)),
			Cloudflare.Telemetry({ headSamplingRate: TRACE_SAMPLING_RATE }),
		]),
	),
)
