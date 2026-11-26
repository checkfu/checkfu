import { normalizeAgentCreateBody } from "@checkfu/sdk/AgentInput"
import type { CreateAgentBody } from "@checkfu/sdk/Api"

export const resourceKinds = ["agent", "environment", "automation"] as const
export type ResourceKind = (typeof resourceKinds)[number]

export const maxProjectSourceBytes = 2 * 1024 * 1024

export const canonicalProjectJson = (value: unknown): string =>
	JSON.stringify(value, (_key, entry: unknown) =>
		typeof entry === "object" && entry !== null && !Array.isArray(entry)
			? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
			: entry,
	) ?? "null"

export const agentProjectDefinition = (body: CreateAgentBody) => ({
	kind: "agent" as const,
	body: normalizeAgentCreateBody(body),
})
