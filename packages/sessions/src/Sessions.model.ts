import * as Domain from "@alchemy.run/domain"
import { Session } from "./Session/Session.aggregate.ts"

export class Sessions extends Domain.Model("Sessions", {
	aggregates: [Session],
	sometimes: {
		ASessionRunsATurn: (m) => m.Session.some((s) => s.state._tag === "Running"),
		ASessionTerminates: (m) => m.Session.some((s) => s.state._tag === "Terminated"),
	},
}) {}

export class SessionsApi extends Domain.Api("SessionsApi", {
	model: Sessions,
	commands: [
		"CreateSession",
		"SendUserMessage",
		"SendUserInterrupt",
		"RecordModelRequestStart",
		"RecordAgentThinking",
		"RecordAgentMessage",
		"RecordModelRequestEnd",
		"CompleteTurn",
		"RecordSessionError",
		"ArchiveSession",
	],
}) {}
