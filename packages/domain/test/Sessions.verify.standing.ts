export const STANDING = {
	"Session.RunningTurnIsPositive": "proved",
	"Session.IdleTurnIsNonNegative": "proved",
	"Session.ModelRequestsStartedNonNegative": "proved",
	"Session.PendingUserMessagesWithinBounds": "proved",
	"Session.OpenModelRequestRequiresStartedCount": "proved",
	"Session.TerminatedSessionStaysTerminated": "proved",
	"Session.ArchivedSessionStaysArchived": "proved",
	"Session.CreatedSessionNeverReturnsToUninitialized": "proved",
	"Session.TurnNeverDecreases": "proved",
	"Session.TurnAdvancesByAtMostOne": "proved",
	"Session.ModelRequestsStartedNeverDecreasesWithinTurn": "proved",
	"Session.ModelRequestsStartedGrowsByAtMostOneWithinTurn": "proved",
	"Session.PendingUserMessagesGrowsByAtMostOneWithinTurn": "proved",
	"Session.OnlySendUserMessageAddsPendingMessages": "proved",
	"Session.OnlyArchiveSessionSetsArchivedFlag": "proved",
	"Session.IdleSessionStartsTheNextTurn": "proved",
	"Session.StatusRunningCarriesStartedTurn": "proved",
	"Session.StatusIdleCarriesEndedTurn": "proved",
	"Session.AbandonedTurnIsTheRunningTurn": "proved",
	"Session.OpenModelRequestClosedBeforeLeavingRunning": "proved",
	"Sessions.SessionViewMatchesSession": "checked",
	"Sessions.TurnInputMatchesSession": "checked",
	"Sessions.ASessionCompletesATurn": "reached",
	"Sessions.ASessionTerminates": "reached",
	"Sessions.ASessionIsArchived": "reached",
	"Sessions.EveryTurnSettles": "checked",
} as const

export const PROVED = Object.entries(STANDING)
	.filter(([, standing]) => standing === "proved")
	.map(([name]) => name)

export const REQUIRED_REPLAY_RULES = [
	"Sessions.ASessionCompletesATurn",
	"Sessions.ASessionTerminates",
	"Sessions.ASessionIsArchived",
] as const

export const REQUIRED_REPLAY_OUTCOMES = [
	"Session.CreateSession → session.created",
	"Session.CreateSession ✗ SessionAlreadyExists",
	"Session.SendUserMessage → user.message",
	"Session.SendUserMessage → session.status_running",
	"Session.SendUserMessage ✗ SessionNotFound",
	"Session.SendUserInterrupt ✗ SessionNotFound",
	"Session.SendUserInterrupt ✗ SessionNotRunning",
	"Session.RecordModelRequestStart → span.model_request_start",
	"Session.CommitModelReply → agent.message",
	"Session.CommitModelReply → span.model_request_end",
	"Session.CommitModelReply → session.status_idle",
	"Session.FailModelRequest → span.model_request_end",
	"Session.FailModelRequest → session.error",
	"Session.FailModelRequest → turn.abandoned",
	"Session.FailModelRequest → session.status_idle",
	"Session.FailModelRequest → session.status_terminated",
	"Session.InterruptModelRequest → span.model_request_end",
	"Session.InterruptModelRequest → session.status_idle",
	"Session.ArchiveSession → session.status_terminated",
	"Session.ArchiveSession → session.archived",
	"Session.ArchiveSession ✗ SessionNotFound",
] as const
