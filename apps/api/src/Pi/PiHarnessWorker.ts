import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Effect from "effect/Effect"
import { Connection } from "../Connection/Connection.do.ts"
import { ApiCatalog } from "../OpenApi/ApiCatalog.do.ts"
import { checkApiServer } from "../OpenApi/ApiCatalogStore.ts"
import { placedStub, placement } from "../Placement.ts"
import { isCheckableInputSchema } from "./PiCustomTools.ts"
import { PiHarnessWorker, TURN_CODE_UPDATE_STRATEGY } from "./PiHarness.ts"
import { SessionWorkspace } from "../Workspace/SessionWorkspace.do.ts"
import { PiSession, PiSessionLive } from "./PiSession.do.ts"

export const PI_HARNESS_WORKER_PROPS = {
	main: import.meta.url,
	compatibility: { date: "2026-11-17" },
	workersDev: false,
	codeUpdateStrategy: TURN_CODE_UPDATE_STRATEGY,
	observability: {
		enabled: true,
		issues: { enabled: true },
	},
	dev: { port: 1339 },
} satisfies Cloudflare.WorkerProps

export default PiHarnessWorker.make(
	PI_HARNESS_WORKER_PROPS,
	Effect.gen(function* () {
		const where = yield* placement
		const piSession = placedStub(yield* PiSession, where)
		// A session's workspace is placed like the session itself.
		const workspace = placedStub(yield* SessionWorkspace, where)
		// A credential's secret is placed like the sessions that use it.
		const connection = placedStub(yield* Connection, where)
		// An API server's document is placed like the sessions that read it.
		const catalog = placedStub(yield* ApiCatalog, where)
		return PiHarnessWorker.of({
			recoverTurn: (conversation, operationId) =>
				Effect.orDie(piSession(conversation).recoverTurn(operationId)),
			runTurn: (conversation, request) => Effect.orDie(piSession(conversation).runTurn(request)),
			resumeTurn: (conversation, operationId, decisions) =>
				Effect.orDie(piSession(conversation).resumeTurn(operationId, decisions)),
			waitingCalls: (conversation) => Effect.orDie(piSession(conversation).waitingCalls()),
			checkToolSchemas: (schemas) => Effect.sync(() => schemas.map(isCheckableInputSchema)),
			checkApiSpec: (document, selection) => checkApiServer(document, selection),
			storeCatalog: (catalogId, document, config) =>
				Effect.orDie(catalog(catalogId).store(document, config)),
			keepCatalog: (catalogId) => Effect.orDie(catalog(catalogId).keep()),
			cancelWaiting: (conversation, operationId) =>
				Effect.orDie(piSession(conversation).cancelWaiting(operationId)),
			abortTurn: (conversation, operationId) =>
				Effect.orDie(piSession(conversation).abortTurn(operationId)),
			discardWorkspace: (sessionId) => Effect.orDie(workspace(sessionId).discard()),
			storeSecret: (credentialId, secret, mcpServerUrl) =>
				Effect.orDie(connection(credentialId).storeSecret(secret, mcpServerUrl)),
			replaceSecret: (credentialId, secret) =>
				Effect.orDie(connection(credentialId).replaceSecret(secret)),
			keepSecret: (credentialId) => Effect.orDie(connection(credentialId).keepSecret()),
			eraseSecret: (credentialId) => Effect.orDie(connection(credentialId).erase()),
			credentialRefreshReport: (credentialId) =>
				Effect.orDie(connection(credentialId).refreshReport()),
			acknowledgeCredentialRefresh: (credentialId, refreshes) =>
				Effect.orDie(connection(credentialId).acknowledgeRefresh(refreshes)),
		})
	}).pipe(Effect.provide([PiSessionLive, Cloudflare.Telemetry({ headSamplingRate: 0.1 })])),
)
