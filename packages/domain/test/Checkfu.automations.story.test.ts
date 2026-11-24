import { Story } from "@alchemy.run/domain/Story"
import { describe, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import { Agent } from "../src/Agent/Agent.aggregate.ts"
import { AgentId } from "../src/Agent/Agent.id.ts"
import { AgentVersion, AgentVersionMinted } from "../src/Agent/AgentVersion.aggregate.ts"
import { AgentVersionId } from "../src/Agent/AgentVersion.id.ts"
import { AgentArchived, ArchiveAgent } from "../src/Agent/ArchiveAgent.command.ts"
import { AgentCreated } from "../src/Agent/CreateAgent.command.ts"
import { AgentUpdated } from "../src/Agent/UpdateAgent.command.ts"
import { Automation } from "../src/Automation/Automation.aggregate.ts"
import { AutomationRunView } from "../src/Automation/AutomationRunView.view.ts"
import { AutomationView } from "../src/Automation/AutomationView.view.ts"
import {
	AdmitAutomation,
	AutomationLimitReached,
	AutomationScheduleUnusable,
} from "../src/Automation/AdmitAutomation.command.ts"
import {
	ArchiveAutomation,
	AutomationArchived,
} from "../src/Automation/ArchiveAutomation.command.ts"
import {
	AutomationCapacity,
	AutomationSlotReserved,
	MAX_LIVE_AUTOMATIONS,
} from "../src/Automation/AutomationCapacity.aggregate.ts"
import { AUTOMATION_CAPACITY } from "../src/Automation/AutomationCapacity.id.ts"
import {
	AutomationAlreadyExists,
	AutomationCreated,
} from "../src/Automation/CreateAutomation.command.ts"
import { AutomationSlotReleased } from "../src/Automation/ReleaseAutomationSlot.command.ts"
import { AgentArchivedError } from "../src/Agent/AgentArchived.rejection.ts"
import { AgentNotFound } from "../src/Agent/AgentNotFound.rejection.ts"
import {
	ArchiveEnvironment,
	EnvironmentArchived,
} from "../src/Environment/ArchiveEnvironment.command.ts"
import { EnvironmentArchivedError } from "../src/Environment/EnvironmentArchived.rejection.ts"
import { EnvironmentNotFound } from "../src/Environment/EnvironmentNotFound.rejection.ts"
import {
	AgentVersionNotFound,
	BoundedAgentId,
	BoundedEnvironmentId,
} from "../src/Session/AdmitSession.command.ts"
import { AutomationPaused } from "../src/Automation/PauseAutomation.command.ts"
import { AutomationRunFailed } from "../src/Automation/RecordAutomationRunFailed.command.ts"
import { AutomationRunStarted } from "../src/Automation/RecordAutomationRunStarted.command.ts"
import { AutomationFired, RunAutomation } from "../src/Automation/RunAutomation.command.ts"
import {
	AGENT_UNAVAILABLE,
	ENVIRONMENT_UNAVAILABLE,
	SESSION_CONFLICT,
} from "../src/Automation/StartAutomationRun.policy.ts"
import { Checkfu, CheckfuHandlersLive } from "../src/Checkfu.model.ts"
import { EnvironmentCreated } from "../src/Environment/CreateEnvironment.command.ts"
import {
	DeleteEnvironment,
	EnvironmentDeleted,
} from "../src/Environment/DeleteEnvironment.command.ts"
import { Environment } from "../src/Environment/Environment.aggregate.ts"
import { EnvironmentId } from "../src/Environment/Environment.id.ts"
import {
	AgentMessage,
	SessionStatusIdle,
	SpanModelRequestEnd,
} from "../src/Session/CommitModelReply.command.ts"
import { SessionCreated } from "../src/Session/CreateSession.command.ts"
import { Harness } from "../src/Session/Harness.external.ts"
import { SpanModelRequestStart } from "../src/Session/RecordModelRequestStart.command.ts"
import { SessionStatusRunning, UserMessage } from "../src/Session/SendUserMessage.command.ts"
import { Session } from "../src/Session/Session.aggregate.ts"
import { SessionId } from "../src/Session/Session.id.ts"
import { SessionView } from "../src/Session/SessionView.view.ts"

const story = Story.make(Checkfu, {
	layer: CheckfuHandlersLive,
	stub: [Harness],
})

const at = (iso: string) => DateTime.makeUnsafe(iso)
const ms = (iso: string) => DateTime.toEpochMillis(at(iso))

const agent = Agent.ref(AgentId.make("agent_001"))
const v1 = AgentVersion.ref(AgentVersionId.make("aver_001"))
const v2 = AgentVersion.ref(AgentVersionId.make("aver_002"))
const environment = Environment.ref(EnvironmentId.make("env_001"))
const automation = Automation.ref("auto_001")
const capacity = AutomationCapacity.ref(AUTOMATION_CAPACITY)
const sessionOf = (run: number) => Session.ref(SessionId.make(`sess_auto_001_${run}`))

const agentFields = {
	name: "Reporter",
	model: { id: "gpt-4o-mini" },
	system: "Be concise.",
	description: null,
}

const config = {
	name: "Morning report",
	agent_id: agent.id,
	agent_version: null as number | null,
	environment_id: environment.id,
	text: "Write the morning report.",
	schedule: { type: "cron" as const, expression: "0 9 * * *", timezone: "UTC" },
}

const world = [
	Story.clock(at("2026-01-01T08:00:00.000Z")),
	Story.given(agent, new AgentCreated({ version: 1, version_id: v1.id, ...agentFields })),
	Story.given(v1, new AgentVersionMinted({ agent_id: agent.id, version: 1, ...agentFields })),
	Story.given(
		environment,
		new EnvironmentCreated({
			version: 1,
			name: "Cloud",
			description: null,
			config: { type: "cloud", networking: { type: "unrestricted" } },
		}),
	),
]

const admit = (overrides: Partial<typeof config> = {}, id = automation.id) =>
	new AdmitAutomation({
		automation_id: id,
		capacity_id: AUTOMATION_CAPACITY,
		...config,
		...overrides,
		agent_id: BoundedAgentId.make(overrides.agent_id ?? config.agent_id),
		environment_id: BoundedEnvironmentId.make(overrides.environment_id ?? config.environment_id),
	})

const created = (agent_version: number | null = null) => [
	...world,
	Story.when(admit({ agent_version })),
	Story.then(automation, new AutomationCreated({ ...config, agent_version })),
	Story.then(capacity, new AutomationSlotReserved({ automation_id: automation.id })),
]

const scheduled = (run: number, iso: string) =>
	new AutomationFired({
		run,
		session_id: sessionOf(run).id,
		trigger: "schedule",
		scheduled_at: ms(iso),
	})

const manual = (run: number) =>
	new AutomationFired({
		run,
		session_id: sessionOf(run).id,
		trigger: "manual",
		scheduled_at: null,
	})

const startedOn = (run: number, iso: string | null) =>
	new AutomationRunStarted({
		run,
		session_id: sessionOf(run).id,
		trigger: iso === null ? "manual" : "schedule",
		scheduled_at: iso === null ? null : ms(iso),
	})

const failedOn = (run: number, iso: string | null, type: string, message: string) =>
	new AutomationRunFailed({
		run,
		trigger: iso === null ? "manual" : "schedule",
		scheduled_at: iso === null ? null : ms(iso),
		error: { type, message },
	})

const opened = (run: number, agent_version: number) => [
	Story.then(
		sessionOf(run),
		new SessionCreated({
			agent_id: agent.id,
			agent_version,
			environment_id: environment.id,
			title: config.name,
		}),
		new UserMessage({ content: [{ type: "text", text: config.text }] }),
		new SessionStatusRunning({ turn: 1, generation: 0 }),
		new SpanModelRequestStart({ model_request_start_id: `${sessionOf(run).id}:turn:1:req:1` }),
	),
	Story.call(Harness.runTurn, {
		session_id: sessionOf(run).id,
		agent_id: agent.id,
		agent_version,
		environment_id: environment.id,
		turn: 1,
	}),
	Story.succeed(Harness.runTurn, {
		thinking: null,
		text: "Report written.",
		input_tokens: 10,
		output_tokens: 5,
		stop_reason: { type: "end_turn" as const },
	}),
	Story.then(
		sessionOf(run),
		new AgentMessage({ content: [{ type: "text", text: "Report written." }] }),
		new SpanModelRequestEnd({
			model_request_start_id: `${sessionOf(run).id}:turn:1:req:1`,
			model_usage: { input_tokens: 10, output_tokens: 5 },
			is_error: false,
		}),
		new SessionStatusIdle({ stop_reason: { type: "end_turn" }, turn: 1, generation: 0 }),
	),
]

describe("Checkfu automations", () => {
	it.effect("opens a fresh session with the automation's message at every firing", () =>
		story(
			...created(),
			Story.clock(at("2026-01-01T09:00:00.000Z")),
			Story.then(
				automation,
				scheduled(1, "2026-01-01T09:00:00.000Z"),
				startedOn(1, "2026-01-01T09:00:00.000Z"),
			),
			...opened(1, 1),
			Story.view(SessionView, sessionOf(1), {
				agent_id: agent.id,
				agent_version: 1,
				environment_id: environment.id,
				title: "Morning report",
				status: "idle",
				turn: 1,
			}),
			Story.clock(at("2026-01-02T09:00:00.000Z")),
			Story.then(
				automation,
				scheduled(2, "2026-01-02T09:00:00.000Z"),
				startedOn(2, "2026-01-02T09:00:00.000Z"),
			),
			...opened(2, 1),
			Story.view(AutomationView, automation, { status: "active", runs: 2 }),
			Story.view(AutomationRunView, automation, { recorded: 2 }),
			Story.emitted(AutomationRunView, automation, [
				startedOn(1, "2026-01-01T09:00:00.000Z"),
				startedOn(2, "2026-01-02T09:00:00.000Z"),
			]),
		),
	)

	it.effect("follows the agent's latest version unless a version is pinned", () => {
		const updated = [
			Story.given(
				agent,
				new AgentUpdated({
					version: 2,
					version_id: v2.id,
					...agentFields,
					system: "Be thorough.",
				}),
			),
			Story.given(
				v2,
				new AgentVersionMinted({
					agent_id: agent.id,
					version: 2,
					...agentFields,
					system: "Be thorough.",
				}),
			),
		]
		return story(
			...created(),
			...updated,
			Story.when(new RunAutomation({ automation_id: automation.id })),
			Story.then(automation, manual(1), startedOn(1, null)),
			Story.replied({ run: 1 }),
			...opened(1, 2),
		).pipe(
			Effect.andThen(
				story(
					...created(1),
					...updated,
					Story.when(new RunAutomation({ automation_id: automation.id })),
					Story.then(automation, manual(1), startedOn(1, null)),
					Story.replied({ run: 1 }),
					...opened(1, 1),
				),
			),
		)
	})

	it.effect("pauses and opens no session once its agent is archived", () =>
		story(
			...created(),
			Story.when(new ArchiveAgent({ agent_id: agent.id })),
			Story.then(agent, new AgentArchived()),
			Story.clock(at("2026-01-01T09:00:00.000Z")),
			Story.then(
				automation,
				scheduled(1, "2026-01-01T09:00:00.000Z"),
				failedOn(
					1,
					"2026-01-01T09:00:00.000Z",
					AGENT_UNAVAILABLE,
					"The automation's agent or pinned agent version is not available.",
				),
				new AutomationPaused({ reason: AGENT_UNAVAILABLE }),
			),
			Story.then(sessionOf(1)),
			Story.view(AutomationView, automation, {
				status: "paused",
				pause_reason: AGENT_UNAVAILABLE,
				runs: 1,
			}),
			Story.emitted(AutomationRunView, automation, [
				failedOn(
					1,
					"2026-01-01T09:00:00.000Z",
					AGENT_UNAVAILABLE,
					"The automation's agent or pinned agent version is not available.",
				),
			]),
			Story.clock(at("2026-01-03T12:00:00.000Z")),
			Story.then(automation),
		),
	)

	it.effect("pauses and opens no session once its environment is deleted", () =>
		story(
			...created(),
			Story.when(new DeleteEnvironment({ environment_id: environment.id })),
			Story.then(environment, new EnvironmentDeleted()),
			Story.when(new RunAutomation({ automation_id: automation.id })),
			Story.then(
				automation,
				manual(1),
				failedOn(
					1,
					null,
					ENVIRONMENT_UNAVAILABLE,
					"The automation's environment is not available.",
				),
				new AutomationPaused({ reason: ENVIRONMENT_UNAVAILABLE }),
			),
			Story.replied({ run: 1 }),
			Story.then(sessionOf(1)),
		),
	)

	it.effect("fails the run and sends nothing to a session that already has the run's id", () =>
		story(
			...created(),
			Story.given(
				sessionOf(1),
				new SessionCreated({
					agent_id: "agent_other",
					agent_version: 3,
					environment_id: "env_other",
					title: "Someone else's session",
				}),
			),
			Story.clock(at("2026-01-01T09:00:00.000Z")),
			Story.then(
				automation,
				scheduled(1, "2026-01-01T09:00:00.000Z"),
				failedOn(
					1,
					"2026-01-01T09:00:00.000Z",
					SESSION_CONFLICT,
					"A session this run did not create already has the run's session id.",
				),
			),
			Story.then(sessionOf(1)),
			Story.state(sessionOf(1), { _tag: "Idle", turn: 0 }),
			Story.view(AutomationView, automation, { status: "active", pause_reason: null }),
			Story.clock(at("2026-01-02T09:00:00.000Z")),
			Story.then(
				automation,
				scheduled(2, "2026-01-02T09:00:00.000Z"),
				startedOn(2, "2026-01-02T09:00:00.000Z"),
			),
			...opened(2, 1),
		),
	)

	it.effect(
		"admits an automation only for a usable schedule and an active agent, version and environment",
		() => {
			const missingAgent = AgentId.make("agent_missing")
			const missingEnvironment = EnvironmentId.make("env_missing")
			const unusable = [
				{ type: "cron" as const, expression: "* * * * *", timezone: "UTC" },
				{ type: "cron" as const, expression: "*/30 * * * *", timezone: "UTC" },
				{ type: "cron" as const, expression: "*/30 0 9 * * *", timezone: "UTC" },
				{ type: "cron" as const, expression: "0 24 * * *", timezone: "UTC" },
				{ type: "cron" as const, expression: "0 0 31 2 *", timezone: "UTC" },
				{ type: "cron" as const, expression: "0 9 * * *", timezone: "+02:00" },
				{ type: "cron" as const, expression: "0 9 * * *", timezone: "Mars/Olympus" },
			]
			return story(
				...world,
				...unusable.flatMap((schedule) => [
					Story.when(admit({ schedule })),
					Story.rejected(new AutomationScheduleUnusable(schedule)),
				]),
				Story.when(admit({ agent_id: missingAgent })),
				Story.rejected(new AgentNotFound({ agent_id: missingAgent })),
				Story.when(admit({ agent_version: 2 })),
				Story.rejected(new AgentVersionNotFound({ agent_id: agent.id, version: 2 })),
				Story.when(admit({ environment_id: missingEnvironment })),
				Story.rejected(new EnvironmentNotFound({ environment_id: missingEnvironment })),
				Story.when(new ArchiveEnvironment({ environment_id: environment.id })),
				Story.then(environment, new EnvironmentArchived()),
				Story.when(admit()),
				Story.rejected(new EnvironmentArchivedError({ environment_id: environment.id })),
				Story.when(new ArchiveAgent({ agent_id: agent.id })),
				Story.then(agent, new AgentArchived()),
				Story.when(admit()),
				Story.rejected(new AgentArchivedError({ agent_id: agent.id })),
				Story.then(automation),
				Story.then(capacity),
			)
		},
	)

	it.effect("admits no automation beyond the limit and frees a slot when one is archived", () => {
		const next = Automation.ref("auto_next")
		const others = Array.from(
			{ length: MAX_LIVE_AUTOMATIONS - 1 },
			(_, index) =>
				new AutomationSlotReserved({ automation_id: Automation.ref(`auto_other_${index}`).id }),
		)
		return story(
			...created(),
			Story.when(admit()),
			Story.rejected(new AutomationAlreadyExists({ automation_id: automation.id })),
			Story.given(capacity, ...others),
			Story.state(capacity, { reserved: MAX_LIVE_AUTOMATIONS }),
			Story.when(admit({}, next.id)),
			Story.rejected(new AutomationLimitReached({ limit: MAX_LIVE_AUTOMATIONS })),
			Story.then(next),
			Story.when(new ArchiveAutomation({ automation_id: automation.id })),
			Story.then(automation, new AutomationArchived()),
			Story.then(capacity, new AutomationSlotReleased({ automation_id: automation.id })),
			Story.when(new ArchiveAutomation({ automation_id: automation.id })),
			Story.then(automation),
			Story.then(capacity),
			Story.when(admit({}, next.id)),
			Story.then(next, new AutomationCreated(config)),
			Story.then(capacity, new AutomationSlotReserved({ automation_id: next.id })),
			Story.state(capacity, { reserved: MAX_LIVE_AUTOMATIONS }),
		)
	})
})
