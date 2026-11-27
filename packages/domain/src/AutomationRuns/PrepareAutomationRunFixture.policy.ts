import * as Domain from "@alchemy.run/domain"
import * as Effect from "effect/Effect"
import { AgentId } from "../Agent/Agent.id.ts"
import { AgentVersionId } from "../Agent/AgentVersion.id.ts"
import { CreateAgent } from "../Agent/CreateAgent.command.ts"
import { CreateAgentDecision } from "../Agent/CreateAgent.decision.ts"
import { AdmitAutomation } from "../Automation/AdmitAutomation.command.ts"
import { AdmitAutomationDecision } from "../Automation/AdmitAutomation.decision.ts"
import { AutomationId } from "../Automation/Automation.id.ts"
import { AUTOMATION_CAPACITY } from "../Automation/AutomationCapacity.id.ts"
import { CreateEnvironment } from "../Environment/CreateEnvironment.command.ts"
import { Environment } from "../Environment/Environment.aggregate.ts"
import { EnvironmentId } from "../Environment/Environment.id.ts"
import { NO_AGENT_TOOLS, NO_MCP_SERVERS } from "../Mcp/McpServers.ts"
import { BoundedAgentId, BoundedEnvironmentId } from "../Session/AdmitSession.command.ts"
import { AutomationRunSetup } from "./AutomationRunSetup.aggregate.ts"
import { AutomationRunPrepared } from "./PrepareAutomationRun.command.ts"

export class PrepareAutomationRunFixture extends Domain.Policy("PrepareAutomationRunFixture", {
	from: AutomationRunSetup,
	on: [AutomationRunPrepared],
}) {}

export const PrepareAutomationRunFixtureLive = PrepareAutomationRunFixture.toLayer(
	Effect.gen(function* () {
		const agents = yield* CreateAgentDecision
		const environments = yield* Environment
		const admissions = yield* AdmitAutomationDecision
		return () =>
			Effect.gen(function* () {
				const agentId = AgentId.make("agent_automation_run")
				const environmentId = EnvironmentId.make("env_automation_run")
				yield* environments.send(
					new CreateEnvironment({
						environment_id: environmentId,
						name: "Run environment",
						description: null,
						config: { type: "cloud", networking: { type: "unrestricted" } },
					}),
				)
				yield* agents.send(
					new CreateAgent({
						agent_id: agentId,
						version_id: AgentVersionId.make("aver_automation_run"),
						name: "Run agent",
						model: { id: "test-model" },
						description: null,
						system: null,
						mcp_servers: NO_MCP_SERVERS,
						tools: NO_AGENT_TOOLS,
					}),
				)
				yield* admissions.send(
					new AdmitAutomation({
						automation_id: AutomationId.make("auto_run"),
						capacity_id: AUTOMATION_CAPACITY,
						name: "Run automation",
						description: null,
						agent_id: BoundedAgentId.make(agentId),
						agent_version: null,
						environment_id: BoundedEnvironmentId.make(environmentId),
						text: "Write a report.",
						schedule: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
					}),
				)
			}).pipe(Effect.orDie)
	}),
)
