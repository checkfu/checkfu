import * as Domain from "@alchemy.run/domain"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { DurableClock } from "effect/workflow"
import { BoundedAgentId, BoundedEnvironmentId } from "../Session/AdmitSession.command.ts"
import { Session } from "../Session/Session.aggregate.ts"
import { SessionId } from "../Session/Session.id.ts"
import { openAutomationRunActivity } from "../Session/RunTurnActivities.ts"
import {
	ErrorMessage,
	ErrorType,
	MessageText,
	ResourceId,
	SessionTitle,
} from "../Session/SessionTypes.ts"
import { SessionView } from "../Session/SessionView.view.ts"
import { Automation } from "./Automation.aggregate.ts"
import { AutomationId } from "./Automation.id.ts"
import { AutomationTrigger, NonNegativeInt, PositiveInt } from "./AutomationTypes.ts"
import { OpenAutomationSession } from "./OpenAutomationSession.command.ts"
import { OpenAutomationSessionDecision } from "./OpenAutomationSession.decision.ts"
import { RecordAutomationRunFailed } from "./RecordAutomationRunFailed.command.ts"
import { RecordAutomationRunStarted } from "./RecordAutomationRunStarted.command.ts"

export const AGENT_UNAVAILABLE = "agent_unavailable"
export const ENVIRONMENT_UNAVAILABLE = "environment_unavailable"
export const SESSION_CONFLICT = "session_conflict"

const AGENT_UNAVAILABLE_MESSAGE = "The automation's agent or pinned agent version is not available."
const ENVIRONMENT_UNAVAILABLE_MESSAGE = "The automation's environment is not available."
const SESSION_CONFLICT_MESSAGE =
	"A session this run did not create already has the run's session id."

export const REPORT_RETRY = "30 seconds"

export const AutomationRunId = Schema.String.check(Schema.isMinLength(1)).pipe(
	Schema.brand("AutomationRunId"),
)
export type AutomationRunId = typeof AutomationRunId.Type

export const automationRunKey = (automation_id: AutomationId, run: number): AutomationRunId =>
	AutomationRunId.make(`${automation_id}:run:${run}`)

export class OpenAutomationRun extends Domain.Saga("OpenAutomationRun", {
	key: AutomationRunId,
	input: {
		automation_id: AutomationId,
		run: PositiveInt,
		session_id: SessionId,
		trigger: AutomationTrigger,
		scheduled_at: Schema.NullOr(NonNegativeInt),
		revision: PositiveInt,
		agent_id: ResourceId,
		agent_version: Schema.NullOr(PositiveInt),
		environment_id: ResourceId,
		title: Schema.NullOr(SessionTitle),
		text: MessageText,
	},
	result: {
		status: Schema.Literals(["started", "failed", "reported"]),
	},
}) {}

const refused = (error_type: string, message: string, unrecoverable: boolean) => ({
	outcome: "refused" as const,
	error_type: ErrorType.make(error_type),
	message: ErrorMessage.make(message),
	unrecoverable,
})

export const OpenAutomationRunLive = OpenAutomationRun.toLayer(
	Effect.gen(function* () {
		const automations = yield* Automation
		const opening = yield* OpenAutomationSessionDecision
		const sessions = yield* SessionView
		return Effect.fn(function* (payload: typeof OpenAutomationRun.workflow.payloadSchema.Type) {
			const alreadyReported = Effect.map(
				automations.get(Automation.ref(payload.automation_id)),
				(state) => state.reported >= payload.run,
			)
			const ownSession = Effect.gen(function* () {
				const existing = Option.getOrNull(
					yield* Effect.orDie(
						sessions.get(Session.ref(payload.session_id), {
							atLeast: { stream: `Session/${payload.session_id}`, version: 1 },
						}),
					),
				)
				return existing !== null &&
					existing.agent_id === payload.agent_id &&
					existing.environment_id === payload.environment_id &&
					existing.title === payload.title
					? {
							outcome: "started" as const,
							agent_id: ResourceId.make(existing.agent_id),
							agent_version: PositiveInt.make(existing.agent_version),
						}
					: refused(SESSION_CONFLICT, SESSION_CONFLICT_MESSAGE, false)
			})
			const opened = yield* openAutomationRunActivity(
				"open",
				Effect.gen(function* () {
					if (yield* alreadyReported) {
						return { outcome: "reported" as const }
					}
					return yield* opening
						.send(
							new OpenAutomationSession({
								session_id: payload.session_id,
								agent_id: BoundedAgentId.make(payload.agent_id),
								agent_version: payload.agent_version,
								environment_id: BoundedEnvironmentId.make(payload.environment_id),
								title: payload.title,
								text: payload.text,
							}),
							{ commandId: `${payload.key}:open` },
						)
						.pipe(
							Effect.flatMap((receipt) => {
								const created = receipt.events.find((event) => event._tag === "session.created")
								return created === undefined
									? Effect.die(new Error("An opened automation session records its agent."))
									: Effect.succeed({
											outcome: "started" as const,
											agent_id: created.agent_id,
											agent_version: created.agent_version,
										})
							}),
							Effect.catchTag("SessionAlreadyExists", () => ownSession),
							Effect.catchTag(["AgentNotFound", "AgentArchivedError", "AgentVersionNotFound"], () =>
								Effect.succeed(refused(AGENT_UNAVAILABLE, AGENT_UNAVAILABLE_MESSAGE, true)),
							),
							Effect.catchTag(["EnvironmentNotFound", "EnvironmentArchivedError"], () =>
								Effect.succeed(
									refused(ENVIRONMENT_UNAVAILABLE, ENVIRONMENT_UNAVAILABLE_MESSAGE, true),
								),
							),
						)
				}),
			)
			if (opened.outcome === "reported") {
				return { status: "reported" as const }
			}
			const run = {
				automation_id: payload.automation_id,
				run: payload.run,
				trigger: payload.trigger,
				scheduled_at: payload.scheduled_at,
			}
			const report =
				opened.outcome === "started"
					? automations.send(
							new RecordAutomationRunStarted({
								...run,
								agent_id: opened.agent_id,
								agent_version: opened.agent_version,
							}),
						)
					: automations.send(
							new RecordAutomationRunFailed({
								...run,
								revision: payload.revision,
								agent_id: payload.agent_id,
								agent_version: payload.agent_version,
								error_type: opened.error_type,
								message: opened.message,
								unrecoverable: opened.unrecoverable,
							}),
						)
			for (let attempt = 1; ; attempt++) {
				const recorded = yield* openAutomationRunActivity(
					"report",
					Effect.gen(function* () {
						const receipt = yield* report
						return receipt.events.length > 0 || (yield* alreadyReported)
					}),
					attempt,
				)
				if (recorded) {
					return {
						status: opened.outcome === "started" ? ("started" as const) : ("failed" as const),
					}
				}
				yield* DurableClock.sleep({ name: `report-wait:${attempt}`, duration: REPORT_RETRY })
			}
		})
	}),
)
