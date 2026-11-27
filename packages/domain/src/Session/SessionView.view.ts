import { SystemMessage } from "./SendSystemMessage.command.ts"
import * as Domain from "@alchemy.run/domain"
import { SessionSnapshot } from "@checkfu/sdk/Schemas"
import * as Schema from "effect/Schema"
import { SessionErrorEvent } from "./AbandonTurn.command.ts"
import { SessionArchived, SessionStatusTerminated } from "./ArchiveSession.command.ts"
import {
	AgentMessage,
	AgentThinking,
	SessionStatusIdle,
	SpanModelRequestEnd,
} from "./CommitModelReply.command.ts"
import { SpanModelRequestStart } from "./RecordModelRequestStart.command.ts"
import { UserToolConfirmation } from "./ConfirmTool.command.ts"
import { UserCustomToolResult } from "./ReturnCustomToolResult.command.ts"
import {
	AgentCustomToolUse,
	AgentMcpToolResult,
	AgentMcpToolUse,
	AgentToolResult,
	AgentToolUse,
} from "./RecordToolCall.command.ts"
import { UserInterrupt } from "./SendUserInterrupt.command.ts"
import { SessionStatusRunning, UserMessage } from "./SendUserMessage.command.ts"
import { decodeMcpServerCredentials } from "../Mcp/McpServers.ts"
import { Session } from "./Session.aggregate.ts"
import { addModelUsage } from "./SessionTypes.ts"

export { SessionSnapshot }

export class SessionView extends Domain.View("SessionView", {
	version: 6,
	from: [Session],
	key: Session,
	state: Schema.NullOr(SessionSnapshot),
	initial: null,
	emit: {
		"user.message": (event, { before }) =>
			before === null ? event : new UserMessage({ content: event.content, turn: before.turn + 1 }),
	},
	events: [
		SystemMessage,
		UserMessage,
		UserInterrupt,
		UserToolConfirmation,
		UserCustomToolResult,
		SessionStatusRunning,
		SpanModelRequestStart,
		AgentToolUse,
		AgentToolResult,
		AgentMcpToolUse,
		AgentMcpToolResult,
		AgentCustomToolUse,
		AgentThinking,
		AgentMessage,
		SpanModelRequestEnd,
		SessionStatusIdle,
		SessionErrorEvent,
		SessionStatusTerminated,
		SessionArchived,
	],
	evolve: {
		"session.created": (state, e, ctx) =>
			state !== null
				? state
				: {
						id: ctx.key.id,
						type: "session" as const,
						status: "idle" as const,
						agent_id: e.agent_id,
						agent_version: e.agent_version,
						environment_id: e.environment_id,
						title: e.title,
						resources: e.resources,
						turn: 0,
						usage: {
							input_tokens: 0,
							output_tokens: 0,
						},
						mcp_server_credentials: decodeMcpServerCredentials(e.mcp_server_credentials),
						created_at: ctx.at,
						updated_at: ctx.at,
						archived_at: null,
					},
		"system.message": (state, _e, ctx) =>
			state === null ? null : { ...state, updated_at: ctx.at },
		"user.message": (state, _e, ctx) => (state === null ? null : { ...state, updated_at: ctx.at }),
		"user.interrupt": (state, _e, ctx) =>
			state === null ? null : { ...state, updated_at: ctx.at },
		"user.tool_confirmation": (state, _e, ctx) =>
			state === null ? null : { ...state, updated_at: ctx.at },
		"user.custom_tool_result": (state, _e, ctx) =>
			state === null ? null : { ...state, updated_at: ctx.at },
		"agent.custom_tool_use": (state, _e, ctx) =>
			state === null ? null : { ...state, updated_at: ctx.at },
		"session.status_running": (state, e, ctx) =>
			state === null
				? null
				: {
						...state,
						status: "running" as const,
						turn: e.turn,
						updated_at: ctx.at,
					},
		"span.model_request_start": (state, _e, ctx) =>
			state === null ? null : { ...state, updated_at: ctx.at },
		"agent.tool_use": (state, _e, ctx) =>
			state === null ? null : { ...state, updated_at: ctx.at },
		"agent.tool_result": (state, _e, ctx) =>
			state === null ? null : { ...state, updated_at: ctx.at },
		"agent.mcp_tool_use": (state, _e, ctx) =>
			state === null ? null : { ...state, updated_at: ctx.at },
		"agent.mcp_tool_result": (state, _e, ctx) =>
			state === null ? null : { ...state, updated_at: ctx.at },
		"agent.thinking": (state, _e, ctx) =>
			state === null ? null : { ...state, updated_at: ctx.at },
		"agent.message": (state, _e, ctx) => (state === null ? null : { ...state, updated_at: ctx.at }),
		"span.model_request_end": (state, e, ctx) =>
			state === null
				? null
				: {
						...state,
						usage: addModelUsage(state.usage, e.model_usage),
						updated_at: ctx.at,
					},
		"session.status_idle": (state, _e, ctx) =>
			state === null
				? null
				: {
						...state,
						status: "idle" as const,
						updated_at: ctx.at,
					},
		"session.error": (state, _e, ctx) => (state === null ? null : { ...state, updated_at: ctx.at }),
		"session.archived": (state, _e, ctx) =>
			state === null
				? null
				: {
						...state,
						archived_at: state.archived_at ?? ctx.at,
						updated_at: ctx.at,
					},
		"session.status_terminated": (state, _e, ctx) =>
			state === null
				? null
				: {
						...state,
						status: "terminated" as const,
						updated_at: ctx.at,
					},
	},
}) {}
