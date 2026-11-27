import { ERROR_CODES } from "@checkfu/sdk/ErrorCodes"
import {
	ArchiveAutomationIfCurrent,
	ArchiveAutomationIfCurrentDecision,
} from "@checkfu/domain/Automation/GuardedArchives"
import { AgentNotFound } from "@checkfu/domain/Agent/AgentNotFound.rejection"
import { EnvironmentNotFound } from "@checkfu/domain/Environment/EnvironmentNotFound.rejection"
import { AgentArchivedError } from "@checkfu/domain/Agent/AgentArchived.rejection"
import { EnvironmentArchivedError } from "@checkfu/domain/Environment/EnvironmentArchived.rejection"
import {
	AdmitAutomation,
	AutomationLimitReached,
	AutomationScheduleUnusable,
} from "@checkfu/domain/Automation/AdmitAutomation.command"
import { AdmitAutomationDecision } from "@checkfu/domain/Automation/AdmitAutomation.decision"
import { ArchiveAutomation } from "@checkfu/domain/Automation/ArchiveAutomation.command"
import { Automation } from "@checkfu/domain/Automation/Automation.aggregate"
import { AutomationId, automationRunId } from "@checkfu/domain/Automation/Automation.id"
import { AUTOMATION_CAPACITY } from "@checkfu/domain/Automation/AutomationCapacity.id"
import { AutomationRunView } from "@checkfu/domain/Automation/AutomationRunView.view"
import { AutomationView } from "@checkfu/domain/Automation/AutomationView.view"
import type { AutomationSnapshot } from "@checkfu/domain/Automation/AutomationView.view"
import { PauseAutomation } from "@checkfu/domain/Automation/PauseAutomation.command"
import type { AutomationRunFailed } from "@checkfu/domain/Automation/RecordAutomationRunFailed.command"
import type { AutomationRunStarted } from "@checkfu/domain/Automation/RecordAutomationRunStarted.command"
import { RunAutomation } from "@checkfu/domain/Automation/RunAutomation.command"
import { firingsAhead, isUsableSchedule, sameSchedule } from "@checkfu/domain/Automation/Schedule"
import { UnpauseAutomation } from "@checkfu/domain/Automation/UnpauseAutomation.command"
import {
	AutomationRevisionConflict,
	UpdateAutomation,
} from "@checkfu/domain/Automation/UpdateAutomation.command"
import { UpdateAutomationDecision } from "@checkfu/domain/Automation/UpdateAutomation.decision"
import {
	AgentVersionNotFound,
	BoundedAgentId,
	BoundedEnvironmentId,
} from "@checkfu/domain/Session/AdmitSession.command"
import { AgentId } from "@checkfu/domain/Agent/Agent.id"
import { EnvironmentId } from "@checkfu/domain/Environment/Environment.id"
import { MAX_MESSAGE_TEXT_LENGTH, MessageText } from "@checkfu/domain/Session/SessionTypes"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Digest from "effect/crypto/Digest"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as DateTime from "effect/DateTime"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Schedule from "effect/Schedule"
import { CheckfuApi } from "./Api.ts"
import { listPage, makeLister } from "./Listing.ts"
import {
	reusedKey,
	commitForStream,
	createIdentity,
	handled,
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
	id: automationRunId(automation_id, entry.event.run),
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
	agent: { id: entry.event.agent_id, version: entry.event.agent_version },
	session_id: entry.event._tag === "automation.run_started" ? entry.event.session_id : null,
	error: entry.event._tag === "automation.run_failed" ? entry.event.error : null,
	created_at: entry.envelope.at,
})

const agentOf = (agent: string | { readonly id: string; readonly version?: number | undefined }) =>
	Effect.gen(function* () {
		const raw = typeof agent === "string" ? agent : agent.id
		const agent_id = Schema.decodeOption(AgentId)(raw)
		if (Option.isNone(agent_id)) {
			return yield* reject(404, `Agent ${raw} not found.`)
		}
		return {
			agent_id: agent_id.value,
			agent_version: typeof agent === "string" ? null : (agent.version ?? null),
		}
	})

const environmentOf = (raw: string) =>
	Effect.gen(function* () {
		const environment_id = Schema.decodeOption(EnvironmentId)(raw)
		if (Option.isNone(environment_id)) {
			return yield* reject(404, `Environment ${raw} not found.`)
		}
		return environment_id.value
	})

const textOf = (
	events: ReadonlyArray<{
		readonly content: ReadonlyArray<{ readonly text: string }>
	}>,
) =>
	Schema.decodeEffect(MessageText)(
		events
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

const rejectUnavailableReference = (status: 404 | 409, description: string | undefined) =>
	reject(status, description ?? "Request rejected.", {
		code: ERROR_CODES.automationReferenceUnavailable,
	})

const rejectUnusableSchedule = () =>
	reject(400, AutomationScheduleUnusable.annotations.description ?? "Invalid schedule.", {
		code: ERROR_CODES.automationScheduleUnusable,
	})

const UPDATE_RETRIES = 3

const present = (snapshot: AutomationSnapshot) =>
	Effect.map(Clock.currentTimeMillis, (now) => automationResource(snapshot, now))

export const AutomationsLive = HttpApiBuilder.group(CheckfuApi, "automations", (handlers) =>
	Effect.gen(function* () {
		const admission = yield* AdmitAutomationDecision
		const updates = yield* UpdateAutomationDecision
		const automations = yield* Automation
		const guardedArchive = yield* ArchiveAutomationIfCurrentDecision
		const automationViews = yield* AutomationView
		const automationRuns = yield* AutomationRunView
		const list = yield* makeLister
		const digest = yield* Digest.Digest
		const random = yield* SecureRandom.SecureRandom

		const committed = (id: AutomationId) =>
			Effect.gen(function* () {
				const state = yield* automations.get(id)
				if (state.status === "") {
					return yield* reject(404, `Automation ${id} not found.`)
				}
				return state
			})

		const findRun = (id: AutomationId, run: number) =>
			Effect.gen(function* () {
				const page = yield* automationRuns.list(Automation.ref(id), { after: run - 1, take: 1 })
				const entry = page.entries[0]
				if (entry === undefined || entry.event.run !== run) {
					return yield* reject(404, `Run ${run} of automation ${id} not found.`)
				}
				return automationRunResource(id, entry)
			})

		const after = (
			id: AutomationId,
			receipt: { readonly stream: string; readonly version: number } | undefined,
		) =>
			Effect.gen(function* () {
				const result = yield* automationViews
					.get(Automation.ref(id), receipt === undefined ? {} : { atLeast: receipt })
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

		const currentOf = (id: AutomationId) =>
			Effect.gen(function* () {
				const found = Option.getOrNull(yield* automationViews.get(Automation.ref(id)))
				if (found !== null) {
					return found
				}
				yield* committed(id)
				return yield* projected(id)
			})

		const archive = (id: AutomationId, revision?: number) =>
			Effect.gen(function* () {
				const commit =
					revision === undefined
						? yield* automations.send(new ArchiveAutomation({ automation_id: id }))
						: commitForStream(
								(yield* guardedArchive.send(
									new ArchiveAutomationIfCurrent({
										automation_id: id,
										expected_revision: revision,
									}),
								)).commits,
								`Automation/${id}`,
							)
				return yield* after(id, commit)
			}).pipe(handled)

		return handlers
			.handle("create", ({ payload, headers }) =>
				Effect.gen(function* () {
					const idempotencyKey = headers["idempotency-key"]
					const { agent_id, agent_version } = yield* agentOf(payload.agent)
					const environment_id = yield* environmentOf(payload.environment_id)
					const command = {
						capacity_id: AUTOMATION_CAPACITY,
						name: payload.name,
						description: payload.description ?? null,
						agent_id,
						agent_version,
						environment_id,
						text: yield* textOf(payload.initial_events),
						schedule: payload.schedule,
					}
					const identity = yield* createIdentity(digest, random, {
						resource: "automation",
						prefix: "auto",
						key: idempotencyKey,
						body: command,
					})
					const id = AutomationId.make(identity.id)
					const receipt = yield* admission
						.send(new AdmitAutomation({ automation_id: id, ...command }), identity.options)
						.pipe(
							Effect.catchTags({
								AutomationAlreadyExists: () =>
									isUsableSchedule(payload.schedule.expression, payload.schedule.timezone)
										? reusedKey
										: rejectUnusableSchedule(),
								AutomationScheduleUnusable: rejectUnusableSchedule,
								AgentNotFound: () =>
									rejectUnavailableReference(404, AgentNotFound.annotations.description),
								AgentVersionNotFound: () =>
									rejectUnavailableReference(404, AgentVersionNotFound.annotations.description),
								EnvironmentNotFound: () =>
									rejectUnavailableReference(404, EnvironmentNotFound.annotations.description),
								AgentArchivedError: () =>
									rejectUnavailableReference(409, AgentArchivedError.annotations.description),
								EnvironmentArchivedError: () =>
									rejectUnavailableReference(409, EnvironmentArchivedError.annotations.description),
								AutomationLimitReached: () =>
									reject(
										429,
										AutomationLimitReached.annotations.description ?? "Request rejected.",
										{
											code: ERROR_CODES.automationCapacityReached,
										},
									),
							}),
						)
					const committed = commitForStream(receipt.commits, `Automation/${id}`)
					return committed === undefined
						? { id, type: "automation" as const, pending: true as const }
						: yield* after(id, committed)
				}).pipe(handled),
			)
			.handle("update", ({ params, payload }) =>
				Effect.gen(function* () {
					const id = params.automation_id
					const agent = payload.agent === undefined ? undefined : yield* agentOf(payload.agent)
					const environment_id =
						payload.environment_id === undefined
							? undefined
							: yield* environmentOf(payload.environment_id)
					const text =
						payload.initial_events === undefined ? undefined : yield* textOf(payload.initial_events)
					const ref = Automation.ref(id)
					const timeout = yield* AutomationReadWaitTimeout
					const send = Effect.gen(function* () {
						const current = yield* currentOf(id)
						if (payload.revision !== undefined && payload.revision !== current.revision) {
							return yield* new AutomationRevisionConflict({
								automation_id: id,
								expected_revision: payload.revision,
								current_revision: current.revision,
							})
						}
						const next = {
							name: payload.name ?? current.name,
							description:
								payload.description === undefined ? current.description : payload.description,
							agent_id: agent?.agent_id ?? BoundedAgentId.make(current.agent_id),
							agent_version: agent === undefined ? current.agent_version : agent.agent_version,
							environment_id: environment_id ?? BoundedEnvironmentId.make(current.environment_id),
							text: text ?? current.text,
							schedule: {
								type: "cron" as const,
								expression: payload.schedule?.expression ?? current.schedule.expression,
								timezone: payload.schedule?.timezone ?? current.schedule.timezone,
							},
						}
						const reschedule = !sameSchedule(next.schedule, current.schedule)
						if (reschedule && !isUsableSchedule(next.schedule.expression, next.schedule.timezone)) {
							return yield* rejectUnusableSchedule()
						}
						const agent_id_changed = next.agent_id !== current.agent_id
						const environment_changed = next.environment_id !== current.environment_id
						const changed = [
							reschedule,
							environment_changed,
							next.name !== current.name,
							next.description !== current.description,
							next.text !== current.text,
						].includes(true)
						const receipt = yield* updates.send(
							new UpdateAutomation({
								automation_id: id,
								expected_revision: current.revision,
								...next,
								changed,
								reschedule,
								agent_id_changed,
								previous_agent_version: current.agent_version,
								environment_changed,
							}),
						)
						return commitForStream(receipt.commits, `Automation/${id}`)
					})
					const committed = yield* Effect.retry(send, {
						schedule: Schedule.recurs(UPDATE_RETRIES),
						while: (error) =>
							payload.revision === undefined &&
							Predicate.isTagged(error, "AutomationRevisionConflict")
								? automationViews
										.waitFor(ref, { revision: { gte: error.current_revision } }, { timeout })
										.pipe(Effect.as(true))
								: false,
					}).pipe(Effect.catchTag("AutomationScheduleUnusable", rejectUnusableSchedule))
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
				Effect.flatMap(currentOf(params.automation_id), present).pipe(handled),
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
			.handle("archive", ({ params, query }) => archive(params.automation_id, query.revision))
			.handle("run", ({ params }) =>
				Effect.gen(function* () {
					const id = params.automation_id
					const receipt = yield* automations.send(new RunAutomation({ automation_id: id }))
					return {
						type: "automation_run" as const,
						id: automationRunId(id, receipt.reply.run),
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
					const after = query.page === undefined ? undefined : Number(query.page)
					const page = yield* automationRuns.list(Automation.ref(id), {
						...(after === undefined ? {} : { after }),
						take: query.limit ?? 50,
						order: query.order ?? "asc",
					})
					return listPage(
						page.entries.map((entry) => automationRunResource(id, entry)),
						page.cursor,
					)
				}).pipe(handled),
			)
			.handle("getRun", ({ params }) =>
				Effect.andThen(
					committed(params.automation_id),
					findRun(params.automation_id, params.run),
				).pipe(handled),
			)
			.handle("getRunById", ({ params }) =>
				Effect.gen(function* () {
					const raw = params.automation_run_id
					const separator = raw.lastIndexOf("_")
					const id = Schema.decodeOption(AutomationId)(raw.slice("arun_".length, separator))
					const run = Number(raw.slice(separator + 1))
					if (
						Option.isNone(id) ||
						!Number.isSafeInteger(run) ||
						run < 1 ||
						automationRunId(id.value, run) !== raw
					) {
						return yield* reject(404, `Automation run ${raw} not found.`)
					}
					const state = yield* committed(id.value)
					if (run > state.runs) {
						return yield* reject(404, `Automation run ${raw} not found.`)
					}
					yield* automationRuns
						.waitFor(
							Automation.ref(id.value),
							{ recorded: { gte: run } },
							{
								timeout: yield* AutomationReadWaitTimeout,
							},
						)
						.pipe(
							Effect.catchTag("WaitTimeout", () =>
								reject(503, `Automation run ${raw} is still starting.`),
							),
						)
					return yield* findRun(id.value, run)
				}).pipe(handled),
			)
	}),
)
