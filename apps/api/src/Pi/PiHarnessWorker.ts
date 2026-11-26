import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { COMPATIBILITY_DATE, TRACE_SAMPLING_RATE } from "../Compatibility.ts"
import { Connection } from "../Connection/Connection.do.ts"
import { placedStub, placement } from "../Placement.ts"
import { PiHarnessWorker, TURN_CODE_UPDATE_STRATEGY } from "./PiHarness.ts"
import { piHarnessAiBindingProps } from "./PiModels.ts"
import { SandboxesCloudflare, sandboxEgress } from "../Sandbox/CloudflareSandboxes.do.ts"
import { SessionWorkspace, SessionWorkspaceLive } from "../Workspace/SessionWorkspace.do.ts"
import { PiSession, PiSessionLive } from "./PiSession.do.ts"
import { customToolFaults } from "./PiToolSchema.ts"

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
		const connection = placedStub(yield* Connection, where)
		return PiHarnessWorker.of({
			recoverTurn: (conversation, operationId) =>
				Effect.orDie(piSession(conversation).recoverTurn(operationId)),
			runTurn: (conversation, request) => Effect.orDie(piSession(conversation).runTurn(request)),
			abortTurn: (conversation, operationId) =>
				Effect.orDie(piSession(conversation).abortTurn(operationId)),
			listOutputs: (sessionId, turn) => Effect.orDie(workspace(sessionId).listOutputs(turn)),
			readOutputs: (sessionId, turn, paths) =>
				Effect.orDie(workspace(sessionId).readOutputs(turn, paths)),
			pauseUsage: (conversation, operationId, pause) =>
				Effect.orDie(piSession(conversation).pauseUsage(operationId, pause)),
			answerCall: (conversation, toolUseId, answer) =>
				Effect.orDie(piSession(conversation).answerCall(toolUseId, answer)),
			customToolFaults: (tools, taken) => Effect.sync(() => customToolFaults(tools, taken)),
			prepareWorkspace: (sessionId, token, repositories, allowedHosts) =>
				Effect.orDie(workspace(sessionId).prepare(token, repositories, allowedHosts)),
			storeRepositoryToken: (sessionId, resourceId, token, replace) =>
				Effect.orDie(workspace(sessionId).storeRepositoryToken(resourceId, token, replace)),
			interruptWorkspace: (sessionId, token) => Effect.orDie(workspace(sessionId).interrupt(token)),
			discardWorkspace: (sessionId) => Effect.orDie(workspace(sessionId).discard(sessionId)),
			fetch: yield* sandboxEgress((sessionId, request) =>
				Effect.orDie(workspace(sessionId).fetch(request)),
			),
			putSecret: (vaultId, credentialId, secret, target, mode) =>
				Effect.orDie(connection(vaultId).putSecret(credentialId, secret, target, mode)),
			secretUsable: (vaultId, credentialId) =>
				Effect.orDie(connection(vaultId).usable(credentialId)),
			eraseSecret: (vaultId, credentialId) =>
				Effect.orDie(connection(vaultId).eraseSecret(credentialId)),
			sealVault: (vaultId) => Effect.orDie(connection(vaultId).seal()),
		})
	}).pipe(
		Effect.provide([
			Layer.provideMerge(PiSessionLive, Layer.provide(SessionWorkspaceLive, SandboxesCloudflare)),
			Cloudflare.Telemetry({ headSamplingRate: TRACE_SAMPLING_RATE }),
		]),
	),
)
