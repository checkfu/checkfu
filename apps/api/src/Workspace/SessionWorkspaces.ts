import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type { HarnessCallFailed } from "../HarnessCall.ts"
import type { OutputBytes, OutputRead, OutputsListing } from "./SessionOutputs.ts"
import type { RepositoryMount, TurnToken, WorkspacePreparation } from "./WorkspaceShapes.ts"

export interface SessionWorkspacesService {
	readonly prepareWorkspace: (
		sessionId: string,
		token: TurnToken,
		repositories: ReadonlyArray<RepositoryMount>,
		allowedHosts: ReadonlyArray<string> | null,
	) => Effect.Effect<WorkspacePreparation, HarnessCallFailed>
	readonly storeRepositoryToken: (
		sessionId: string,
		resourceId: string,
		token: string,
		replace: boolean,
	) => Effect.Effect<void, HarnessCallFailed>
	readonly interruptWorkspace: (
		sessionId: string,
		token: TurnToken,
	) => Effect.Effect<void, HarnessCallFailed>
	readonly listOutputs: (
		sessionId: string,
		turn: number,
	) => Effect.Effect<OutputsListing | null, HarnessCallFailed>
	readonly readOutputs: (
		sessionId: string,
		turn: number,
		files: ReadonlyArray<OutputRead>,
	) => Effect.Effect<ReadonlyArray<OutputBytes> | null, HarnessCallFailed>
	readonly discardWorkspace: (sessionId: string) => Effect.Effect<void, HarnessCallFailed>
}

export class SessionWorkspaces extends Context.Service<
	SessionWorkspaces,
	SessionWorkspacesService
>()("@checkfu/api/SessionWorkspaces") {}
