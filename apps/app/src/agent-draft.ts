import type { JsonAgent } from "@checkfu/sdk/client"

export interface AgentDraft {
	readonly name: string
	readonly model: string
	readonly system: string
	readonly description: string
}

export const FIELD_LABELS: Record<keyof AgentDraft, string> = {
	name: "name",
	model: "model",
	system: "system prompt",
	description: "description",
}

const FIELDS = ["name", "model", "system", "description"] as const

export const emptyDraft: AgentDraft = { name: "", model: "", system: "", description: "" }

export const draftOf = (agent: JsonAgent): AgentDraft => ({
	name: agent.name,
	model: agent.model.id,
	system: agent.system ?? "",
	description: agent.description ?? "",
})

export const bodyOf = (draft: AgentDraft) => ({
	name: draft.name.trim(),
	model: draft.model.trim(),
	system: draft.system === "" ? null : draft.system,
	description: draft.description === "" ? null : draft.description,
})

const edited = (base: AgentDraft, draft: AgentDraft): ReadonlyArray<keyof AgentDraft> =>
	FIELDS.filter((field) => draft[field] !== base[field])

export const changesFrom = (from: JsonAgent, draft: AgentDraft) => {
	const before = draftOf(from)
	const body = bodyOf(draft)
	return {
		...(draft.name === before.name ? {} : { name: body.name }),
		...(draft.model === before.model ? {} : { model: body.model }),
		...(draft.system === before.system ? {} : { system: body.system }),
		...(draft.description === before.description ? {} : { description: body.description }),
	}
}

export interface Rebased {
	readonly draft: AgentDraft
	readonly overlapping: ReadonlyArray<keyof AgentDraft>
}

export const rebase = (base: JsonAgent, draft: AgentDraft, latest: JsonAgent): Rebased => {
	const mine = new Set(edited(draftOf(base), draft))
	const theirs = new Set(edited(draftOf(base), draftOf(latest)))
	const current = draftOf(latest)
	const pick = (field: keyof AgentDraft) => (mine.has(field) ? draft : current)[field]
	return {
		draft: {
			name: pick("name"),
			model: pick("model"),
			system: pick("system"),
			description: pick("description"),
		},
		overlapping: [...mine].filter((field) => theirs.has(field)),
	}
}
