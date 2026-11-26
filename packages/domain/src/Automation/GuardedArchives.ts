import * as Domain from "@alchemy.run/domain"
import type { Read } from "@alchemy.run/domain/Decision"
import { PositiveInt } from "@checkfu/sdk/Schemas"
import * as Schema from "effect/Schema"
import { AgentId } from "../Agent/Agent.id.ts"
import { Agent } from "../Agent/Agent.aggregate.ts"
import { AgentNotFound } from "../Agent/AgentNotFound.rejection.ts"
import { AgentArchived } from "../Agent/ArchiveAgent.command.ts"
import { AgentVersionConflict } from "../Agent/UpdateAgent.command.ts"
import { EnvironmentArchived } from "../Environment/ArchiveEnvironment.command.ts"
import { Environment } from "../Environment/Environment.aggregate.ts"
import { EnvironmentId } from "../Environment/Environment.id.ts"
import { EnvironmentNotFound } from "../Environment/EnvironmentNotFound.rejection.ts"
import { EnvironmentVersionConflict } from "../Environment/UpdateEnvironment.command.ts"
import { AutomationArchived } from "./ArchiveAutomation.command.ts"
import { Automation } from "./Automation.aggregate.ts"
import { AutomationId } from "./Automation.id.ts"
import { AutomationCapacity, MAX_LIVE_AUTOMATIONS } from "./AutomationCapacity.aggregate.ts"
import { AUTOMATION_CAPACITY } from "./AutomationCapacity.id.ts"
import { AutomationNotFound } from "./AutomationNotFound.rejection.ts"
import { AutomationRevisionConflict } from "./UpdateAutomation.command.ts"

const AutomationReference = Schema.Struct({
	id: AutomationId,
	revision: PositiveInt,
	agent_id: AgentId,
	environment_id: EnvironmentId,
})
export type AutomationReference = typeof AutomationReference.Type

export class AutomationInventoryChanged extends Domain.Rejection(
	"AutomationInventoryChanged",
	{},
	{
		httpApiStatus: 503,
		description: "The automation inventory changed. Retry after the list catches up.",
	},
) {}

export class AutomationDependencyInUse extends Domain.Rejection(
	"AutomationDependencyInUse",
	{ automation_id: AutomationId },
	{ httpApiStatus: 409, description: "A live automation still references this resource." },
) {}

const archiveInventory = Schema.Array(AutomationReference).check(
	Schema.isMaxLength(MAX_LIVE_AUTOMATIONS),
)

const referenceConflict = (
	capacity: Read<typeof AutomationCapacity>,
	automations: ReadonlyArray<Read<typeof Automation>>,
	inventory: ReadonlyArray<AutomationReference>,
	field: "agent_id" | "environment_id",
	id: string,
) => {
	const snapshots = new Map(inventory.map((entry) => [entry.id, entry]))
	const live = automations.filter(
		({ state }) => state.status === "active" || state.status === "paused",
	)
	// Admission reserves a slot atomically. Slot release can lag, so reserved is an upper
	// bound. Equality proves the listing covers every live automation at this transaction.
	if (snapshots.size !== inventory.length || live.length !== capacity.state.reserved) {
		return new AutomationInventoryChanged()
	}
	for (const automation of live) {
		const view = snapshots.get(automation.id)
		if (view === undefined || view.revision !== automation.state.revision) {
			return new AutomationInventoryChanged()
		}
		if (view[field] === id) {
			return new AutomationDependencyInUse({ automation_id: automation.id })
		}
	}
	return undefined
}

// Separate decision names make an older Durable Object refuse the command before writing.
export class ArchiveAgentIfCurrent extends Domain.Command("ArchiveAgentIfCurrent", {
	input: { agent_id: AgentId, expected_version: PositiveInt, inventory: archiveInventory },
	events: [AgentArchived],
	rejects: [
		AgentNotFound,
		AgentVersionConflict,
		AutomationInventoryChanged,
		AutomationDependencyInUse,
	],
}) {}

export class ArchiveAgentIfCurrentDecision extends Domain.Decision(ArchiveAgentIfCurrent, {
	reads: { agent: Agent, capacity: AutomationCapacity, automations: Automation },
	keyOf: (cmd) => ({
		agent: cmd.agent_id,
		capacity: AUTOMATION_CAPACITY,
		automations: cmd.inventory.map(({ id }) => id),
	}),
	decide: ({ agent, capacity, automations }, cmd) => {
		if (agent.state.status === "") {
			return new AgentNotFound({ agent_id: agent.id })
		}
		if (agent.state.status === "archived") {
			return []
		}
		if (cmd.expected_version !== agent.state.version) {
			return new AgentVersionConflict({
				agent_id: agent.id,
				expected_version: cmd.expected_version,
				current_version: agent.state.version,
			})
		}
		return (
			referenceConflict(capacity, automations, cmd.inventory, "agent_id", agent.id) ?? [
				agent.record(new AgentArchived()),
			]
		)
	},
}) {}

export class ArchiveEnvironmentIfCurrent extends Domain.Command("ArchiveEnvironmentIfCurrent", {
	input: {
		environment_id: EnvironmentId,
		expected_version: PositiveInt,
		inventory: archiveInventory,
	},
	events: [EnvironmentArchived],
	rejects: [
		EnvironmentNotFound,
		EnvironmentVersionConflict,
		AutomationInventoryChanged,
		AutomationDependencyInUse,
	],
}) {}

export class ArchiveEnvironmentIfCurrentDecision extends Domain.Decision(
	ArchiveEnvironmentIfCurrent,
	{
		reads: { environment: Environment, capacity: AutomationCapacity, automations: Automation },
		keyOf: (cmd) => ({
			environment: cmd.environment_id,
			capacity: AUTOMATION_CAPACITY,
			automations: cmd.inventory.map(({ id }) => id),
		}),
		decide: ({ environment, capacity, automations }, cmd) => {
			if (environment.state.status === "" || environment.state.status === "deleted") {
				return new EnvironmentNotFound({ environment_id: environment.id })
			}
			if (environment.state.status === "archived") {
				return []
			}
			if (cmd.expected_version !== environment.state.version) {
				return new EnvironmentVersionConflict({
					environment_id: environment.id,
					expected_version: cmd.expected_version,
					current_version: environment.state.version,
				})
			}
			return (
				referenceConflict(
					capacity,
					automations,
					cmd.inventory,
					"environment_id",
					environment.id,
				) ?? [environment.record(new EnvironmentArchived())]
			)
		},
	},
) {}

export class ArchiveAutomationIfCurrent extends Domain.Command("ArchiveAutomationIfCurrent", {
	input: { automation_id: AutomationId, expected_revision: PositiveInt },
	events: [AutomationArchived],
	rejects: [AutomationNotFound, AutomationRevisionConflict],
}) {}

export class ArchiveAutomationIfCurrentDecision extends Domain.Decision(
	ArchiveAutomationIfCurrent,
	{
		reads: { automation: Automation },
		keyOf: (cmd) => ({ automation: cmd.automation_id }),
		decide: ({ automation }, cmd) => {
			if (automation.state.status === "") {
				return new AutomationNotFound({ automation_id: automation.id })
			}
			if (automation.state.status === "archived") {
				return []
			}
			if (cmd.expected_revision !== automation.state.revision) {
				return new AutomationRevisionConflict({
					automation_id: automation.id,
					expected_revision: cmd.expected_revision,
					current_revision: automation.state.revision,
				})
			}
			return [automation.record(new AutomationArchived())]
		},
	},
) {}
