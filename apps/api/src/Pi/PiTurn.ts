import { ModelStopReason, TurnInterrupted } from "@checkfu/domain/Session/Harness.external"
import { ModelUsage } from "@checkfu/domain/Session/SessionTypes"
import * as Schema from "effect/Schema"
import {
	MemoryChanges,
	MemoryFile,
	MemoryMount,
	MemorySaved,
	RepositoryMount,
	TurnToken,
	WorkspacePreparation,
} from "../Workspace/WorkspaceShapes.ts"
import { SUPPORTED_PROVIDERS } from "./PiCatalog.ts"

export const PiTurnRequest = Schema.Struct({
	operationId: Schema.String,
	turn: Schema.Finite,
	provider: Schema.Literals(SUPPORTED_PROVIDERS),
	modelId: Schema.String,
	system: Schema.NullOr(Schema.String),
	text: Schema.String,
	unpublishedOperationIds: Schema.optionalKey(Schema.Array(Schema.String)),
})
export type PiTurnRequest = typeof PiTurnRequest.Type

export const PiTurnReply = Schema.Struct({
	thinking: Schema.NullOr(Schema.String),
	text: Schema.String,
	input_tokens: Schema.Finite,
	output_tokens: Schema.Finite,
	stop_reason: ModelStopReason,
})

// Not held to the domain's length limits: the API clamps a failure after it arrives.
export const PiTurnFailed = Schema.TaggedStruct("TurnFailed", {
	error_type: Schema.String,
	message: Schema.String,
	terminal: Schema.Boolean,
	model_usage: Schema.optionalKey(ModelUsage),
})

export const PiTurnOutcome = Schema.Union([
	Schema.Struct({ ok: Schema.Literal(true), reply: PiTurnReply }),
	Schema.Struct({
		ok: Schema.Literal(false),
		error: Schema.Union([PiTurnFailed, TurnInterrupted]),
	}),
])
export type PiTurnOutcome = typeof PiTurnOutcome.Type

export const PiRecoveredTurn = Schema.NullOr(PiTurnOutcome)

// Every method the harness Worker serves, as its argument tuple and its result. The RPC type
// and the persisted lock are both derived from this, so neither can describe a different call.
export const PiHarnessCalls = {
	recoverTurn: { args: Schema.Tuple([Schema.String, Schema.String]), result: PiRecoveredTurn },
	runTurn: { args: Schema.Tuple([Schema.String, PiTurnRequest]), result: PiTurnOutcome },
	abortTurn: { args: Schema.Tuple([Schema.String, Schema.String]), result: Schema.Boolean },
	// The workspace is the harness's: its tools run next to the session object that calls them.
	enterWorkspace: { args: Schema.Tuple([Schema.String, TurnToken]), result: Schema.Boolean },
	// The last argument is the hosts the session's environment lets the workspace reach, or null.
	prepareWorkspace: {
		args: Schema.Tuple([
			Schema.String,
			TurnToken,
			Schema.Array(RepositoryMount),
			Schema.NullOr(Schema.Array(Schema.String)),
		]),
		result: WorkspacePreparation,
	},
	storeRepositoryToken: {
		args: Schema.Tuple([Schema.String, Schema.String, Schema.String, Schema.Boolean]),
		result: Schema.Void,
	},
	mountMemory: {
		args: Schema.Tuple([Schema.String, TurnToken, MemoryMount]),
		result: Schema.Array(Schema.String),
	},
	fillMemory: {
		args: Schema.Tuple([Schema.String, TurnToken, Schema.String, Schema.Array(MemoryFile)]),
		result: Schema.Void,
	},
	memoryChanges: {
		args: Schema.Tuple([Schema.String, TurnToken, Schema.String]),
		result: MemoryChanges,
	},
	memoryContents: {
		args: Schema.Tuple([Schema.String, TurnToken, Schema.String, Schema.Array(Schema.String)]),
		result: Schema.Array(MemoryFile),
	},
	memorySaved: {
		args: Schema.Tuple([Schema.String, TurnToken, Schema.String, MemorySaved]),
		result: Schema.Void,
	},
	discardWorkspace: { args: Schema.Tuple([Schema.String]), result: Schema.Void },
} as const
