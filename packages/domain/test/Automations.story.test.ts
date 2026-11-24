import * as Domain from "@alchemy.run/domain"
import { Story } from "@alchemy.run/domain/Story"
import { describe, expect, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import {
	ArchiveAutomation,
	AutomationArchived,
} from "../src/Automation/ArchiveAutomation.command.ts"
import { ArmAutomationLive } from "../src/Automation/ArmAutomation.policy.ts"
import { Automation } from "../src/Automation/Automation.aggregate.ts"
import { AutomationArchivedError } from "../src/Automation/AutomationArchived.rejection.ts"
import { AutomationNotFound } from "../src/Automation/AutomationNotFound.rejection.ts"
import { AutomationRunView } from "../src/Automation/AutomationRunView.view.ts"
import { SCHEDULE_EXHAUSTED } from "../src/Automation/AutomationTypes.ts"
import {
	isUsableSchedule,
	nextOccurrence,
	firingsAhead,
	upcomingOccurrences,
} from "../src/Automation/Schedule.ts"
import { AutomationView } from "../src/Automation/AutomationView.view.ts"
import {
	AutomationAlreadyExists,
	AutomationCreated,
	CreateAutomation,
} from "../src/Automation/CreateAutomation.command.ts"
import { FireAutomation } from "../src/Automation/FireAutomation.command.ts"
import { AutomationPaused, PauseAutomation } from "../src/Automation/PauseAutomation.command.ts"
import {
	AutomationRunFailed,
	RecordAutomationRunFailed,
} from "../src/Automation/RecordAutomationRunFailed.command.ts"
import {
	AutomationRunStarted,
	RecordAutomationRunStarted,
} from "../src/Automation/RecordAutomationRunStarted.command.ts"
import { AutomationFired, RunAutomation } from "../src/Automation/RunAutomation.command.ts"
import {
	AutomationUnpaused,
	UnpauseAutomation,
} from "../src/Automation/UnpauseAutomation.command.ts"
import { Automations } from "../src/Automations.model.ts"
import { SessionId } from "../src/Session/Session.id.ts"

const story = Story.make(Automations, { layer: ArmAutomationLive })

const at = (iso: string) => DateTime.makeUnsafe(iso)
const ms = (iso: string) => DateTime.toEpochMillis(at(iso))

const automation = Automation.ref("auto_001")

const dailyAtNine = {
	type: "cron" as const,
	expression: "0 9 * * *",
	timezone: "UTC",
}

const config = {
	name: "Morning report",
	agent_id: "agent_001",
	agent_version: null,
	environment_id: "env_001",
	text: "Write the morning report.",
	schedule: dailyAtNine,
}

const created = (schedule: typeof config.schedule = dailyAtNine) => [
	Story.clock(at("2026-01-01T08:00:00.000Z")),
	Story.when(new CreateAutomation({ automation_id: automation.id, ...config, schedule })),
	Story.then(automation, new AutomationCreated({ ...config, schedule })),
]

const scheduled = (run: number, iso: string) =>
	new AutomationFired({
		run,
		session_id: SessionId.make(`sess_auto_001_${run}`),
		trigger: "schedule",
		scheduled_at: ms(iso),
	})

const manual = (run: number) =>
	new AutomationFired({
		run,
		session_id: SessionId.make(`sess_auto_001_${run}`),
		trigger: "manual",
		scheduled_at: null,
	})

describe("Automations", () => {
	it.effect("is well defined", () =>
		Effect.scoped(Layer.build(Automations.layer(ArmAutomationLive))).pipe(
			Effect.provide(Domain.InMemory),
		),
	)

	it.effect("fires at each occurrence of its schedule and arms the next one", () =>
		story(
			...created(),
			Story.view(AutomationView, automation, {
				id: automation.id,
				type: "automation",
				status: "active",
				pause_reason: null,
				runs: 0,
				last_run_at: null,
				schedule: dailyAtNine,
			}),
			Story.clock(at("2026-01-01T08:59:59.000Z")),
			Story.then(automation),
			Story.clock(at("2026-01-01T09:00:00.000Z")),
			Story.then(automation, scheduled(1, "2026-01-01T09:00:00.000Z")),
			Story.clock(at("2026-01-02T09:00:00.000Z")),
			Story.then(automation, scheduled(2, "2026-01-02T09:00:00.000Z")),
			Story.view(AutomationView, automation, {
				runs: 2,
				last_run_at: at("2026-01-02T09:00:00.000Z"),
			}),
		),
	)

	it.effect("follows the schedule's timezone", () =>
		story(
			...created({ type: "cron", expression: "0 9 * * *", timezone: "America/New_York" }),
			Story.clock(at("2026-01-01T13:59:00.000Z")),
			Story.then(automation),
			Story.clock(at("2026-01-01T14:00:00.000Z")),
			Story.then(automation, scheduled(1, "2026-01-01T14:00:00.000Z")),
		),
	)

	it.effect("previews the firing it has armed, also inside a daylight-saving gap", () => {
		const schedule = {
			type: "cron" as const,
			expression: "15 2 * * *",
			timezone: "America/New_York",
		}
		const previewed = (now: string, expected: ReadonlyArray<string>) =>
			Story.view(AutomationView, automation, (state) => {
				expect(
					state === null
						? []
						: firingsAhead(state.upcoming, ms(now))
								.slice(0, 2)
								.map((instant) => DateTime.formatIso(DateTime.makeUnsafe(instant))),
				).toEqual(expected)
			})
		return story(
			Story.clock(at("2026-03-06T12:00:00.000Z")),
			Story.when(new CreateAutomation({ automation_id: automation.id, ...config, schedule })),
			Story.then(automation, new AutomationCreated({ ...config, schedule })),
			Story.clock(at("2026-03-07T07:15:00.000Z")),
			Story.then(automation, scheduled(1, "2026-03-07T07:15:00.000Z")),
			previewed("2026-03-07T07:15:00.000Z", [
				"2026-03-08T07:15:00.000Z",
				"2026-03-09T06:15:00.000Z",
			]),
			Story.clock(at("2026-03-08T07:05:00.000Z")),
			Story.then(automation),
			previewed("2026-03-08T07:05:00.000Z", [
				"2026-03-08T07:15:00.000Z",
				"2026-03-09T06:15:00.000Z",
			]),
			Story.clock(at("2026-03-08T07:15:00.000Z")),
			Story.then(automation, scheduled(2, "2026-03-08T07:15:00.000Z")),
			previewed("2026-03-08T07:15:00.000Z", [
				"2026-03-09T06:15:00.000Z",
				"2026-03-10T06:15:00.000Z",
			]),
		)
	})

	it.effect("fires once for occurrences missed while it could not run", () =>
		story(
			...created(),
			Story.clock(at("2026-01-04T10:30:00.000Z")),
			Story.then(automation, scheduled(1, "2026-01-01T09:00:00.000Z")),
			Story.clock(at("2026-01-05T08:59:00.000Z")),
			Story.then(automation),
			Story.clock(at("2026-01-05T09:00:00.000Z")),
			Story.then(automation, scheduled(2, "2026-01-05T09:00:00.000Z")),
		),
	)

	it.effect("stops firing while paused and resumes without making up missed occurrences", () =>
		story(
			...created(),
			Story.when(new PauseAutomation({ automation_id: automation.id })),
			Story.then(automation, new AutomationPaused({ reason: "manual" })),
			Story.view(AutomationView, automation, { status: "paused", pause_reason: "manual" }),
			Story.when(new PauseAutomation({ automation_id: automation.id })),
			Story.then(automation),
			Story.clock(at("2026-01-03T12:00:00.000Z")),
			Story.then(automation),
			Story.when(new UnpauseAutomation({ automation_id: automation.id })),
			Story.then(automation, new AutomationUnpaused({ activation: 1 })),
			Story.view(AutomationView, automation, { status: "active", pause_reason: null }),
			Story.when(new UnpauseAutomation({ automation_id: automation.id })),
			Story.then(automation),
			Story.clock(at("2026-01-04T08:59:00.000Z")),
			Story.then(automation),
			Story.clock(at("2026-01-04T09:00:00.000Z")),
			Story.then(automation, scheduled(1, "2026-01-04T09:00:00.000Z")),
		),
	)

	it.effect("runs on request, even while paused, without moving the schedule", () =>
		story(
			...created(),
			Story.clock(at("2026-01-01T08:30:00.000Z")),
			Story.when(new RunAutomation({ automation_id: automation.id })),
			Story.then(automation, manual(1)),
			Story.replied({ run: 1 }),
			Story.view(
				AutomationView,
				automation,
				(state) =>
					state?.upcoming[0] === ms("2026-01-01T09:00:00.000Z") &&
					state.last_run_at !== null &&
					DateTime.toEpochMillis(state.last_run_at) === ms("2026-01-01T08:30:00.000Z"),
			),
			Story.clock(at("2026-01-01T09:00:00.000Z")),
			Story.then(automation, scheduled(2, "2026-01-01T09:00:00.000Z")),
			Story.when(new PauseAutomation({ automation_id: automation.id })),
			Story.then(automation, new AutomationPaused({ reason: "manual" })),
			Story.when(new RunAutomation({ automation_id: automation.id })),
			Story.then(automation, manual(3)),
			Story.replied({ run: 3 }),
			Story.clock(at("2026-01-03T12:00:00.000Z")),
			Story.then(automation),
		),
	)

	it.effect("never fires again once archived", () =>
		story(
			...created(),
			Story.when(new ArchiveAutomation({ automation_id: automation.id })),
			Story.then(automation, new AutomationArchived()),
			Story.view(AutomationView, automation, {
				status: "archived",
				archived_at: at("2026-01-01T08:00:00.000Z"),
			}),
			Story.when(new ArchiveAutomation({ automation_id: automation.id })),
			Story.then(automation),
			Story.clock(at("2026-01-03T12:00:00.000Z")),
			Story.then(automation),
			Story.when(new RunAutomation({ automation_id: automation.id })),
			Story.rejected(new AutomationArchivedError({ automation_id: automation.id })),
			Story.when(new PauseAutomation({ automation_id: automation.id })),
			Story.rejected(new AutomationArchivedError({ automation_id: automation.id })),
			Story.when(new UnpauseAutomation({ automation_id: automation.id })),
			Story.rejected(new AutomationArchivedError({ automation_id: automation.id })),
		),
	)

	it.effect("ignores a firing that arrives while paused or after it is archived", () =>
		story(
			...created(),
			Story.when(new PauseAutomation({ automation_id: automation.id })),
			Story.then(automation, new AutomationPaused({ reason: "manual" })),
			Story.when(
				new FireAutomation({
					automation_id: automation.id,
					activation: 0,
					scheduled_at: ms("2026-01-01T09:00:00.000Z"),
				}),
			),
			Story.then(automation),
			Story.when(new ArchiveAutomation({ automation_id: automation.id })),
			Story.then(automation, new AutomationArchived()),
			Story.when(
				new FireAutomation({
					automation_id: automation.id,
					activation: 0,
					scheduled_at: ms("2026-01-01T09:00:00.000Z"),
				}),
			),
			Story.then(automation),
			Story.state(automation, { runs: 0, last_scheduled_at: 0 }),
		),
	)

	it.effect("ignores a firing that fell due while paused and arrives after the resume", () =>
		story(
			...created(),
			Story.when(new PauseAutomation({ automation_id: automation.id })),
			Story.then(automation, new AutomationPaused({ reason: "manual" })),
			Story.clock(at("2026-01-01T09:00:01.000Z")),
			Story.when(new UnpauseAutomation({ automation_id: automation.id })),
			Story.then(automation, new AutomationUnpaused({ activation: 1 })),
			Story.when(
				new FireAutomation({
					automation_id: automation.id,
					activation: 0,
					scheduled_at: ms("2026-01-01T09:00:00.000Z"),
				}),
			),
			Story.then(automation),
			Story.state(automation, { runs: 0, activation: 1 }),
			Story.when(new PauseAutomation({ automation_id: automation.id })),
			Story.then(automation, new AutomationPaused({ reason: "manual" })),
			Story.when(new UnpauseAutomation({ automation_id: automation.id })),
			Story.then(automation, new AutomationUnpaused({ activation: 2 })),
			Story.when(
				new FireAutomation({
					automation_id: automation.id,
					activation: 1,
					scheduled_at: ms("2026-01-01T09:30:00.000Z"),
				}),
			),
			Story.then(automation),
			Story.clock(at("2026-01-02T09:00:00.000Z")),
			Story.then(automation, scheduled(1, "2026-01-02T09:00:00.000Z")),
		),
	)

	it.effect("ignores a firing for an instant it already fired for", () =>
		story(
			...created(),
			Story.clock(at("2026-01-01T09:00:00.000Z")),
			Story.then(automation, scheduled(1, "2026-01-01T09:00:00.000Z")),
			Story.when(
				new FireAutomation({
					automation_id: automation.id,
					activation: 0,
					scheduled_at: ms("2026-01-01T09:00:00.000Z"),
				}),
			),
			Story.then(automation),
			Story.state(automation, { runs: 1, last_scheduled_at: ms("2026-01-01T09:00:00.000Z") }),
		),
	)

	it.effect("pauses an automation whose schedule can never fire", () => {
		const unusable = [
			{ type: "cron" as const, expression: "0 0 31 2 *", timezone: "UTC" },
			{ type: "cron" as const, expression: "0 9 * * *", timezone: "+02:00" },
			{ type: "cron" as const, expression: "0 9 * * *", timezone: "Mars/Olympus" },
			{ type: "cron" as const, expression: "*/30 0 9 * * *", timezone: "UTC" },
		]
		return Effect.forEach(
			unusable,
			(schedule) =>
				story(
					Story.clock(at("2026-01-01T08:00:00.000Z")),
					Story.when(new CreateAutomation({ automation_id: automation.id, ...config, schedule })),
					Story.then(
						automation,
						new AutomationCreated({ ...config, schedule }),
						new AutomationPaused({ reason: SCHEDULE_EXHAUSTED }),
					),
					Story.view(AutomationView, automation, {
						status: "paused",
						pause_reason: SCHEDULE_EXHAUSTED,
					}),
				),
			{ discard: true },
		)
	})

	it.effect("records each run once, in order, with its session or its error", () => {
		const first = {
			automation_id: automation.id,
			run: 1,
			trigger: "schedule" as const,
			scheduled_at: ms("2026-01-01T09:00:00.000Z"),
		}
		const second = {
			automation_id: automation.id,
			run: 2,
			trigger: "schedule" as const,
			scheduled_at: ms("2026-01-02T09:00:00.000Z"),
		}
		const started = new AutomationRunStarted({
			run: 1,
			session_id: SessionId.make("sess_auto_001_1"),
			trigger: "schedule",
			scheduled_at: first.scheduled_at,
		})
		const failed = new AutomationRunFailed({
			run: 2,
			trigger: "schedule",
			scheduled_at: second.scheduled_at,
			error: { type: "session_unavailable", message: "The session stopped." },
		})
		return story(
			...created(),
			Story.clock(at("2026-01-01T09:00:00.000Z")),
			Story.then(automation, scheduled(1, "2026-01-01T09:00:00.000Z")),
			Story.when(new RecordAutomationRunStarted(second)),
			Story.then(automation),
			Story.when(new RecordAutomationRunStarted(first)),
			Story.then(automation, started),
			Story.when(new RecordAutomationRunStarted(first)),
			Story.then(automation),
			Story.clock(at("2026-01-02T09:00:00.000Z")),
			Story.then(automation, scheduled(2, "2026-01-02T09:00:00.000Z")),
			Story.when(
				new RecordAutomationRunFailed({
					...second,
					error_type: "session_unavailable",
					message: "The session stopped.",
					unrecoverable: false,
				}),
			),
			Story.then(automation, failed),
			Story.view(AutomationRunView, automation, { recorded: 2 }),
			Story.emitted(AutomationRunView, automation, [started, failed]),
			Story.view(AutomationView, automation, { status: "active" }),
		)
	})

	it.effect("pauses after a run fails for a reason a retry cannot fix", () =>
		story(
			...created(),
			Story.when(new RunAutomation({ automation_id: automation.id })),
			Story.then(automation, manual(1)),
			Story.replied({ run: 1 }),
			Story.when(
				new RecordAutomationRunFailed({
					automation_id: automation.id,
					run: 1,
					trigger: "manual",
					scheduled_at: null,
					error_type: "agent_unavailable",
					message: "The agent is archived.",
					unrecoverable: true,
				}),
			),
			Story.then(
				automation,
				new AutomationRunFailed({
					run: 1,
					trigger: "manual",
					scheduled_at: null,
					error: { type: "agent_unavailable", message: "The agent is archived." },
				}),
				new AutomationPaused({ reason: "agent_unavailable" }),
			),
			Story.view(AutomationView, automation, {
				status: "paused",
				pause_reason: "agent_unavailable",
			}),
			Story.clock(at("2026-01-03T12:00:00.000Z")),
			Story.then(automation),
		),
	)

	it("accepts a schedule that names one minute in a named time zone, and nothing else", () => {
		const usable = [
			["0 9 * * 1-5", "America/New_York"],
			["45 * * * *", "UTC"],
			["0 0 9 * * *", "UTC"],
			["0 9 * * *", "EST"],
			["0 9 * * *", "GMT+0"],
			["0 9 * * *", "GMT-0"],
			["0 9 * * *", "Etc/GMT+5"],
			["0 0 29 2 *", "UTC"],
		] as const
		const unusable = [
			["* * * * *", "UTC"],
			["*/30 * * * *", "UTC"],
			["0,30 9 * * *", "UTC"],
			["*/30 0 9 * * *", "UTC"],
			["0 24 * * *", "UTC"],
			["0 0 31 2 *", "UTC"],
			["0 0 30 2 *", "UTC"],
			["0 9 * *", "UTC"],
			["@daily", "UTC"],
			["0 9 * * *", "+02:00"],
			["0 9 * * *", "+99:99"],
			["0 9 * * *", "+02"],
			["0 9 * * *", "-00"],
			["0 9 * * *", "-05"],
			["0 9 * * *", "+0200"],
			["0 9 * * *", "Mars/Olympus"],
			["0 9 * * *", ""],
		] as const
		expect(usable.filter(([expression, zone]) => !isUsableSchedule(expression, zone))).toEqual([])
		expect(unusable.filter(([expression, zone]) => isUsableSchedule(expression, zone))).toEqual([])
		expect(nextOccurrence("0 0 31 2 *", "UTC", ms("2026-01-01T00:00:00.000Z"))).toBeNull()
	})

	it("shows an overdue firing once, then only the stored firings after now", () => {
		const stored = upcomingOccurrences("0 * * * *", "UTC", ms("2026-01-01T08:30:00.000Z"), 5)
		const ahead = (now: string) =>
			firingsAhead(stored, ms(now)).map((instant) =>
				DateTime.formatIso(DateTime.makeUnsafe(instant)),
			)
		expect(ahead("2026-01-01T08:40:00.000Z")).toEqual([
			"2026-01-01T09:00:00.000Z",
			"2026-01-01T10:00:00.000Z",
			"2026-01-01T11:00:00.000Z",
			"2026-01-01T12:00:00.000Z",
			"2026-01-01T13:00:00.000Z",
		])
		expect(ahead("2026-01-01T12:30:00.000Z")).toEqual([
			"2026-01-01T09:00:00.000Z",
			"2026-01-01T13:00:00.000Z",
		])
		expect(firingsAhead([], 0)).toEqual([])
	})

	it.effect(
		"computes a sparse schedule's firings once, when the schedule moves, not on every read",
		() =>
			story(
				Story.clock(at("2026-01-01T00:00:00.000Z")),
				Story.when(
					new CreateAutomation({
						automation_id: automation.id,
						...config,
						schedule: { type: "cron", expression: "59 23 29 2 */7", timezone: "America/New_York" },
					}),
				),
				Story.then(
					automation,
					new AutomationCreated({
						...config,
						schedule: { type: "cron", expression: "59 23 29 2 */7", timezone: "America/New_York" },
					}),
				),
				Story.view(AutomationView, automation, (state) => state?.upcoming.length === 5),
			),
	)

	it("limits a schedule to one firing per clock hour, which a half-hour clock change can halve", () => {
		const around = (timezone: string, from: string) =>
			upcomingOccurrences("45 * * * *", timezone, ms(from), 3).map((instant) =>
				DateTime.formatIso(DateTime.makeUnsafe(instant)),
			)
		expect(around("UTC", "2026-10-03T14:00:00.000Z")).toEqual([
			"2026-10-03T14:45:00.000Z",
			"2026-10-03T15:45:00.000Z",
			"2026-10-03T16:45:00.000Z",
		])
		expect(around("Australia/Lord_Howe", "2026-10-03T14:00:00.000Z")).toEqual([
			"2026-10-03T14:15:00.000Z",
			"2026-10-03T15:15:00.000Z",
			"2026-10-03T15:45:00.000Z",
		])
	})

	it.effect("refuses a second automation under one id and commands for an unknown one", () =>
		story(
			...created(),
			Story.when(new CreateAutomation({ automation_id: automation.id, ...config })),
			Story.rejected(new AutomationAlreadyExists({ automation_id: automation.id })),
			Story.when(new PauseAutomation({ automation_id: Automation.ref("auto_missing").id })),
			Story.rejected(new AutomationNotFound({ automation_id: Automation.ref("auto_missing").id })),
			Story.when(new UnpauseAutomation({ automation_id: Automation.ref("auto_missing").id })),
			Story.rejected(new AutomationNotFound({ automation_id: Automation.ref("auto_missing").id })),
			Story.when(new ArchiveAutomation({ automation_id: Automation.ref("auto_missing").id })),
			Story.rejected(new AutomationNotFound({ automation_id: Automation.ref("auto_missing").id })),
			Story.when(new RunAutomation({ automation_id: Automation.ref("auto_missing").id })),
			Story.rejected(new AutomationNotFound({ automation_id: Automation.ref("auto_missing").id })),
		),
	)
})
