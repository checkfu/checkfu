import type { JsonAgent } from "@checkfu/sdk/client"
import { describe, expect, it } from "vitest"
import { changesFrom, draftOf, rebase } from "../src/agent-draft.ts"

const agent = (
	version: number,
	fields: Partial<Pick<JsonAgent, "name" | "system" | "description">>,
): JsonAgent => ({
	type: "agent",
	id: "agent_1",
	version,
	name: " Padded ",
	model: { id: "claude-sonnet-5-5" },
	system: "Be brief.",
	description: null,
	mcp_servers: [],
	tools: [],
	created_at: "2026-11-24T00:00:00.000Z",
	updated_at: "2026-11-24T00:00:00.000Z",
	archived_at: null,
	...fields,
})

describe("agent drafts", () => {
	it("sends nothing for an unedited agent, even with padding in its name", () => {
		const base = agent(1, {})
		expect(changesFrom(base, draftOf(base))).toEqual({})
	})

	it("normalizes only the fields the user changed", () => {
		const base = agent(1, {})
		expect(changesFrom(base, { ...draftOf(base), description: "Helps" })).toEqual({
			description: "Helps",
		})
		expect(changesFrom(base, { ...draftOf(base), name: "  Renamed  " })).toEqual({
			name: "Renamed",
		})
	})

	it("applies the user's edits to a newer version and names the fields both changed", () => {
		const base = agent(1, {})
		const draft = { ...draftOf(base), system: "Be thorough.", description: "Mine" }
		const latest = agent(2, { system: "Be kind.", name: "Theirs" })
		const rebased = rebase(base, draft, latest)
		expect(rebased.draft).toEqual({
			name: "Theirs",
			model: "claude-sonnet-5-5",
			system: "Be thorough.",
			description: "Mine",
		})
		expect(rebased.overlapping).toEqual(["system"])
		expect(changesFrom(latest, rebased.draft)).toEqual({
			system: "Be thorough.",
			description: "Mine",
		})
	})
})
