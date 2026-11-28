import { normalizeAgentCreateBody } from "@checkfu/sdk/AgentInput"
import type { CreateAgentBody, CreateAutomationBody } from "@checkfu/sdk/Api"

import type { JsonAutomation } from "@checkfu/sdk/client"

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

type SavedAutomation = Pick<
	JsonAutomation,
	"name" | "description" | "agent" | "environment_id" | "initial_events" | "schedule"
>

export const savedAutomationDefinition = ({
	name,
	description,
	agent,
	environment_id,
	initial_events,
	schedule,
}: SavedAutomation) => ({
	kind: "automation" as const,
	body: {
		name,
		description,
		agent: { type: "agent" as const, id: agent.id, version: agent.version },
		environment_id,
		initial_events,
		schedule,
	},
})

export const automationProjectDefinition = ({
	name,
	description,
	agent,
	environment_id,
	initial_events,
	schedule,
}: CreateAutomationBody) => ({
	kind: "automation" as const,
	body: {
		name,
		description: description ?? null,
		agent: typeof agent === "string" ? agent : agent.version === undefined ? agent.id : agent,
		environment_id,
		initial_events: [
			{
				type: "user.message" as const,
				content: [
					{
						type: "text" as const,
						text: initial_events
							.flatMap((event) => event.content.map((block) => block.text))
							.join("\n"),
					},
				],
			},
		],
		schedule,
	},
})
