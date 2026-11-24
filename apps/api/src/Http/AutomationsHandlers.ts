import {
	AdmitAutomation,
	AutomationScheduleUnusable,
} from "@checkfu/domain/Automation/AdmitAutomation.command"
import { AdmitAutomationDecision } from "@checkfu/domain/Automation/AdmitAutomation.decision"
import { ArchiveAutomation } from "@checkfu/domain/Automation/ArchiveAutomation.command"
import { Automation } from "@checkfu/domain/Automation/Automation.aggregate"
import { AutomationId } from "@checkfu/domain/Automation/Automation.id"
import { AUTOMATION_CAPACITY } from "@checkfu/domain/Automation/AutomationCapacity.id"
import { AutomationRunView } from "@checkfu/domain/Automation/AutomationRunView.view"
import { AutomationView } from "@checkfu/domain/Automation/AutomationView.view"
import type { AutomationSnapshot } from "@checkfu/domain/Automation/AutomationView.view"
import { PauseAutomation } from "@checkfu/domain/Automation/PauseAutomation.command"
import type { AutomationRunFailed } from "@checkfu/domain/Automation/RecordAutomationRunFailed.command"
import type { AutomationRunStarted } from "@checkfu/domain/Automation/RecordAutomationRunStarted.command"
import { RunAutomation } from "@checkfu/domain/Automation/RunAutomation.command"
import { firingsAhead, isUsableSchedule } from "@checkfu/domain/Automation/Schedule"
import { UnpauseAutomation } from "@checkfu/domain/Automation/UnpauseAutomation.command"
import { AgentId } from "@checkfu/domain/Agent/Agent.id"
import { EnvironmentId } from "@checkfu/domain/Environment/Environment.id"
import { MAX_MESSAGE_TEXT_LENGTH, MessageText } from "@checkfu/domain/Session/SessionTypes"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Digest from "effect/crypto/Digest"
import * as DateTime from "effect/DateTime"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { CheckfuApi } from "./Api.ts"
import { makeLister } from "./Listing.ts"
import {
	IDEMPOTENCY_KEY_REUSED,
	commitForStream,
	createCommandId,
	handled,
	idempotentId,
	isPending,
	orPending,
	reject,
} from "./HttpHelpers.ts"

export const AutomationReadWaitTimeout = Context.Reference<Duration.Input>(
	"@checkfu/api/AutomationReadWaitTimeout",
	{ defaultValue: () => "5 seconds" },
)

const automationResource = (snapshot: AutomationSnapshot, now: number) => {
	const {
		agent_id,
		agent_version,
		text,
		runs,
		activation: _activation,
		upcoming,
		...rest
	} = snapshot
	return {
		...rest,
		agent: { id: agent_id, version: agent_version },
		initial_events: [{ type: "user.message" as const, content: [{ type: "text" as const, text }] }],
		run_count: runs,
		upcoming_runs_at:
			snapshot.status === "active"
				? firingsAhead(upcoming, now).map((at) => DateTime.makeUnsafe(at))
				: [],
	}
}

const automationRunResource = (
	automation_id: AutomationId,
	entry: {
		readonly event: AutomationRunStarted | AutomationRunFailed
		readonly envelope: { readonly at: DateTime.Utc }
	},
) => ({
	type: "automation_run" as const,
	automation_id,
	run: entry.event.run,
	status:
		entry.event._tag === "automation.run_started" ? ("started" as const) : ("failed" as const),
	trigger:
		entry.event.scheduled_at === null
			? { type: "manual" as const }
			: {
					type: "schedule" as const,
					scheduled_at: DateTime.makeUnsafe(entry.event.scheduled_at),
				},
	session_id: entry.event._tag === "automation.run_started" ? entry.event.session_id : null,
	error: entry.event._tag === "automation.run_failed" ? entry.event.error : null,
	created_at: entry.envelope.at,
})

const present = (snapshot: AutomationSnapshot) =>
	Effect.map(Clock.currentTimeMillis, (now) => automationResource(snapshot, now))

export const AutomationsLive = HttpApiBuilder.group(CheckfuApi, "automations", (handlers) =>
	Effect.gen(function* () {
		const admission = yield* AdmitAutomationDecision
		const automations = yield* Automation
		const automationViews = yield* AutomationView
		const automationRuns = yield* AutomationRunView
		const list = yield* makeLister
		const digest = yield* Digest.Digest

		const committed = (id: AutomationId) =>
			Effect.gen(function* () {
				const state = yield* automations.get(id)
				if (state.status === "") {
					return yield* reject(404, `Automation ${id} not found.`)
				}
				return state
			})

		const after = (
			id: AutomationId,
			receipt: { readonly stream: string; readonly version: number },
		) =>
			Effect.gen(function* () {
				const result = yield* automationViews
					.get(Automation.ref(id), { atLeast: receipt })
					.pipe(orPending(id, "automation"))
				if (isPending(result)) {
					return result
				}
				const head = Option.getOrNull(result)
				return head === null
					? { id, type: "automation" as const, pending: true as const }
					: yield* present(head)
			})

		const projected = (id: AutomationId) =>
			Effect.gen(function* () {
				const snapshot = yield* automationViews.waitFor(
					Automation.ref(id),
					{ id },
					{ timeout: yield* AutomationReadWaitTimeout },
				)
				if (snapshot === null) {
					return yield* reject(503, `Automation ${id} projection is not ready.`)
				}
				return snapshot
			})

		const snapshotOf = (id: AutomationId) =>
			Effect.flatMap(automationViews.get(Automation.ref(id)), (found) => {
				const snapshot = Option.getOrNull(found)
				return snapshot === null ? projected(id) : Effect.succeed(snapshot)
			})

		return handlers
			.handle("create", ({ payload, headers }) =>
				Effect.gen(function* () {
					const idempotencyKey = headers["idempotency-key"]
					const rawAgentId = typeof payload.agent === "string" ? payload.agent : payload.agent.id
					const agentId = Schema.decodeOption(AgentId)(rawAgentId)
					if (Option.isNone(agentId)) {
						return yield* reject(404, `Agent ${rawAgentId} not found.`)
					}
					const environmentId = Schema.decodeOption(EnvironmentId)(payload.environment_id)
					if (Option.isNone(environmentId)) {
						return yield* reject(404, `Environment ${payload.environment_id} not found.`)
					}
					if (!isUsableSchedule(payload.schedule.expression, payload.schedule.timezone)) {
						return yield* new AutomationScheduleUnusable(payload.schedule)
					}
					const text = yield* Schema.decodeEffect(MessageText)(
						payload.initial_events
							.flatMap((event) => event.content)
							.map((block) => block.text)
							.join("\n"),
					).pipe(
						Effect.catch(() =>
							reject(
								400,
								`initial_events combined text must be between 1 and ${MAX_MESSAGE_TEXT_LENGTH} characters.`,
							),
						),
					)
					const command = {
						capacity_id: AUTOMATION_CAPACITY,
						name: payload.name,
						agent_id: agentId.value,
						agent_version:
							typeof payload.agent === "string" ? null : (payload.agent.version ?? null),
						environment_id: environmentId.value,
						text,
						schedule: payload.schedule,
					}
					const commandId = yield* createCommandId(digest, "automation", idempotencyKey, command)
					const id = AutomationId.make(
						yield* idempotentId(digest, "auto", ["create", "automation", "id", idempotencyKey]),
					)
					const receipt = yield* admission
						.send(new AdmitAutomation({ automation_id: id, ...command }), { commandId })
						.pipe(
							Effect.catchTag("AutomationAlreadyExists", () => reject(409, IDEMPOTENCY_KEY_REUSED)),
						)
					const committed = commitForStream(receipt.commits, `Automation/${id}`)
					return committed === undefined
						? { id, type: "automation" as const, pending: true as const }
						: yield* after(id, committed)
				}).pipe(handled),
			)
			.handle("list", ({ query }) =>
				list("automation", query, (id) =>
					Effect.flatMap(snapshotOf(AutomationId.make(id)), present),
				).pipe(handled),
			)
			.handle("get", ({ params }) =>
				Effect.gen(function* () {
					const id = params.automation_id
					const ref = Automation.ref(id)
					const found = Option.getOrNull(yield* automationViews.get(ref))
					if (found !== null) {
						return yield* present(found)
					}
					yield* committed(id)
					return yield* present(yield* projected(id))
				}).pipe(handled),
			)
			.handle("pause", ({ params }) =>
				Effect.gen(function* () {
					const id = params.automation_id
					return yield* after(
						id,
						yield* automations.send(new PauseAutomation({ automation_id: id })),
					)
				}).pipe(handled),
			)
			.handle("unpause", ({ params }) =>
				Effect.gen(function* () {
					const id = params.automation_id
					return yield* after(
						id,
						yield* automations.send(new UnpauseAutomation({ automation_id: id })),
					)
				}).pipe(handled),
			)
			.handle("archive", ({ params }) =>
				Effect.gen(function* () {
					const id = params.automation_id
					return yield* after(
						id,
						yield* automations.send(new ArchiveAutomation({ automation_id: id })),
					)
				}).pipe(handled),
			)
			.handle("run", ({ params }) =>
				Effect.gen(function* () {
					const id = params.automation_id
					const receipt = yield* automations.send(new RunAutomation({ automation_id: id }))
					return {
						type: "automation_run" as const,
						automation_id: id,
						run: receipt.reply.run,
						status: "queued" as const,
						trigger: { type: "manual" as const },
					}
				}).pipe(handled),
			)
			.handle("listRuns", ({ params, query }) =>
				Effect.gen(function* () {
					const id = params.automation_id
					yield* committed(id)
					const page = yield* automationRuns.list(Automation.ref(id), {
						...(query.after === undefined ? {} : { after: query.after }),
						take: query.limit ?? 50,
						order: query.order ?? "asc",
					})
					return {
						data: page.entries.map((entry) => automationRunResource(id, entry)),
						has_more: page.cursor !== null,
						next_cursor: page.cursor,
					}
				}).pipe(handled),
			)
	}),
)
