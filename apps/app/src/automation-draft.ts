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

/**
 * The fields the user edited, measured against the draft the editor opened with, so the server
 * keeps everything else: changes another editor made meanwhile, and stored text the user never
 * touched. Only edited fields are normalized.
 */
export const changesOf = (base: AutomationDraft, draft: AutomationDraft): UpdateAutomationBody => {
	const next = createBodyOf(draft)
	const edited = (field: keyof AutomationDraft) => draft[field] !== base[field]
	return {
		...(edited("name") ? { name: next.name } : {}),
		...(edited("description") ? { description: next.description ?? null } : {}),
		...(edited("agentId") ? { agent: draft.agentId } : {}),
		...(edited("environmentId") ? { environment_id: draft.environmentId } : {}),
		...(edited("message") ? { initial_events: next.initial_events } : {}),
		// Each schedule field on its own, so an edit to one keeps another editor's change to the other.
		...(edited("expression") || edited("timezone")
			? {
					schedule: {
						...(edited("expression") ? { expression: next.schedule.expression } : {}),
						...(edited("timezone") ? { timezone: next.schedule.timezone } : {}),
					},
				}
			: {}),
	}
}

/** Whether a read of the automation already shows an update, so the editor can close on it. */
export const showsChanges = (automation: JsonAutomation, changes: UpdateAutomationBody): boolean =>
	[
		changes.name === undefined || automation.name === changes.name,
		changes.description === undefined || automation.description === changes.description,
		changes.agent === undefined ||
			[
				automation.agent.id ===
					(typeof changes.agent === "string" ? changes.agent : changes.agent.id),
				automation.agent.version ===
					(typeof changes.agent === "string" ? null : (changes.agent.version ?? null)),
			].every(Boolean),
		changes.environment_id === undefined || automation.environment_id === changes.environment_id,
		changes.initial_events === undefined ||
			JSON.stringify(automation.initial_events) === JSON.stringify(changes.initial_events),
		changes.schedule?.expression === undefined ||
			automation.schedule.expression === changes.schedule.expression,
		changes.schedule?.timezone === undefined ||
			automation.schedule.timezone === changes.schedule.timezone,
	].every(Boolean)

const firingFormat = (timeZone: string, withYear: boolean) =>
	new Intl.DateTimeFormat(undefined, {
		weekday: "short",
		...(withYear ? { year: "numeric" } : {}),
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		timeZone,
		timeZoneName: "short",
	})

/**
 * A firing time as the automation's own timezone shows it, with the year when it is not this one.
 * A zone the server knows but this browser does not falls back to UTC, labelled as such.
 */
export const firingLabel = (iso: string, timezone: string, now = Date.now()): string => {
	const at = new Date(iso)
	const withYear = at.getUTCFullYear() !== new Date(now).getUTCFullYear()
	try {
		return firingFormat(timezone, withYear).format(at)
	} catch (error) {
		if (error instanceof RangeError) {
			return firingFormat("UTC", withYear).format(at)
		}
		throw error
	}
}
