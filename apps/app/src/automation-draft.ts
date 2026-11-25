import type { CreateAutomationBody, UpdateAutomationBody } from "@checkfu/sdk/Api"
import type { JsonAutomation } from "@checkfu/sdk/client"

export interface AutomationDraft {
	readonly name: string
	readonly description: string
	readonly agentId: string
	readonly environmentId: string
	readonly message: string
	readonly expression: string
	readonly timezone: string
}

export const localTimezone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone

export const emptyDraft = (timezone: string): AutomationDraft => ({
	name: "",
	description: "",
	agentId: "",
	environmentId: "",
	message: "",
	expression: "0 9 * * 1-5",
	timezone,
})

export const messageOf = (automation: JsonAutomation): string =>
	automation.initial_events
		.flatMap((event) => event.content)
		.map((block) => block.text)
		.join("\n")

export const draftOf = (automation: JsonAutomation): AutomationDraft => ({
	name: automation.name,
	description: automation.description ?? "",
	agentId: automation.agent.id,
	environmentId: automation.environment_id,
	message: messageOf(automation),
	expression: automation.schedule.expression,
	timezone: automation.schedule.timezone,
})

const initialEvents = (message: string) => [
	{ type: "user.message" as const, content: [{ type: "text" as const, text: message.trim() }] },
]

const schedule = (draft: AutomationDraft) => ({
	type: "cron" as const,
	expression: draft.expression.trim(),
	timezone: draft.timezone.trim(),
})

const descriptionOf = (draft: AutomationDraft): string | null =>
	draft.description.trim() === "" ? null : draft.description.trim()

export const createBodyOf = (draft: AutomationDraft): CreateAutomationBody => ({
	name: draft.name.trim(),
	description: descriptionOf(draft),
	agent: draft.agentId,
	environment_id: draft.environmentId,
	initial_events: initialEvents(draft.message),
	schedule: schedule(draft),
})

/** Only what the draft changes, so the server keeps every field the user did not touch. */
export const changesOf = (
	automation: JsonAutomation,
	draft: AutomationDraft,
): UpdateAutomationBody => {
	const next = createBodyOf(draft)
	const was = draftOf(automation)
	return {
		...(next.name === automation.name ? {} : { name: next.name }),
		...(next.description === (automation.description ?? null)
			? {}
			: { description: next.description ?? null }),
		...(draft.agentId === was.agentId ? {} : { agent: draft.agentId }),
		...(draft.environmentId === was.environmentId ? {} : { environment_id: draft.environmentId }),
		...(draft.message.trim() === was.message ? {} : { initial_events: next.initial_events }),
		...(next.schedule.expression === automation.schedule.expression &&
		next.schedule.timezone === automation.schedule.timezone
			? {}
			: { schedule: next.schedule }),
	}
}

/** A firing time as the automation's own timezone shows it. */
export const firingLabel = (iso: string, timezone: string): string =>
	new Intl.DateTimeFormat(undefined, {
		weekday: "short",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		timeZone: timezone,
		timeZoneName: "short",
	}).format(new Date(iso))
