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

const fieldEdited = (
	base: AutomationDraft,
	draft: AutomationDraft,
	field: keyof AutomationDraft,
): boolean => draft[field] !== base[field] && draft[field].trim() !== base[field]

export const changesOf = (base: AutomationDraft, draft: AutomationDraft): UpdateAutomationBody => {
	const next = createBodyOf(draft)
	const edited = (field: keyof AutomationDraft) => fieldEdited(base, draft, field)
	return {
		...(edited("name") ? { name: next.name } : {}),
		...(edited("description") ? { description: next.description ?? null } : {}),
		...(edited("agentId") ? { agent: draft.agentId } : {}),
		...(edited("environmentId") ? { environment_id: draft.environmentId } : {}),
		...(edited("message") ? { initial_events: next.initial_events } : {}),
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

const agentPin = ({ agent }: JsonAutomation) => `${agent.id} (version ${agent.version})`

export const conflictsOf = (
	base: JsonAutomation,
	current: JsonAutomation,
	changes: UpdateAutomationBody,
) => {
	const fields = [
		["Name", changes.name, base.name, current.name],
		["Description", changes.description, base.description, current.description],
		["Agent", changes.agent, agentPin(base), agentPin(current)],
		["Environment", changes.environment_id, base.environment_id, current.environment_id],
		["Message", changes.initial_events, messageOf(base), messageOf(current)],
		[
			"Schedule",
			changes.schedule?.expression,
			base.schedule.expression,
			current.schedule.expression,
		],
		["Timezone", changes.schedule?.timezone, base.schedule.timezone, current.schedule.timezone],
	] as const
	return fields.flatMap(([label, edit, opened, newest]) =>
		edit !== undefined && opened !== newest ? [{ label, value: newest }] : [],
	)
}

export const rebaseDraft = (
	base: AutomationDraft,
	draft: AutomationDraft,
	latest: AutomationDraft,
): AutomationDraft => {
	const valueOf = (field: keyof AutomationDraft) =>
		fieldEdited(base, draft, field) ? draft[field] : latest[field]
	return {
		name: valueOf("name"),
		description: valueOf("description"),
		agentId: valueOf("agentId"),
		environmentId: valueOf("environmentId"),
		message: valueOf("message"),
		expression: valueOf("expression"),
		timezone: valueOf("timezone"),
	}
}

export const showsChanges = (automation: JsonAutomation, changes: UpdateAutomationBody): boolean =>
	[
		changes.name === undefined || automation.name === changes.name,
		changes.description === undefined || automation.description === changes.description,
		changes.agent === undefined ||
			(typeof changes.agent === "string"
				? automation.agent.id === changes.agent
				: automation.agent.id === changes.agent.id &&
					(changes.agent.version === undefined ||
						automation.agent.version === changes.agent.version)),
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

const yearFormat = (timeZone: string) =>
	new Intl.DateTimeFormat("en", { calendar: "gregory", year: "numeric", timeZone })

const firingYear = (timeZone: string) => {
	try {
		return yearFormat(timeZone)
	} catch (error) {
		if (error instanceof RangeError) {
			return yearFormat("UTC")
		}
		throw error
	}
}

export const firingLabel = (iso: string, timezone: string, now = Date.now()): string => {
	const at = new Date(iso)
	const year = firingYear(timezone)
	const withYear = year.format(at) !== year.format(now)
	return firingFormat(year.resolvedOptions().timeZone, withYear).format(at)
}
