import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { Checkfu } from "@checkfu/sdk"
import type { JsonAgent } from "@checkfu/sdk"
import { AgentResource, AutomationResource } from "@checkfu/sdk/Api"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import type { CallToolRequestParams } from "@modelcontextprotocol/client"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import { buildCliPackage } from "../../../../tools/release/Build.ts"
import { cliProcessEnv } from "../../../cli/test/helpers/ProcessEnv.ts"

const execute = promisify(execFile)
const definition = (prompt: string) =>
	`---\nname: Report writer\nmodel: gpt-4o-mini\n---\n\n${prompt}\n`
const decodeExecError = Schema.decodeUnknownSync(
	Schema.Struct({ code: Schema.Int, stderr: Schema.String }),
)
const decodeAgent = Schema.decodeUnknownSync(Schema.toCodecJson(AgentResource))
const decodeAutomation = Schema.decodeUnknownSync(Schema.toCodecJson(AutomationResource))

interface PlanRow {
	readonly file: string
	readonly action: string
	readonly id?: string
}

const resourceId = (rows: ReadonlyArray<PlanRow>, file: string) => {
	const id = rows.find((row) => row.file === file)?.id
	if (id === undefined) {
		throw new Error(`No resource ID for ${file}`)
	}
	return id
}

export const authoredProjectJourney = async (options: {
	readonly baseUrl: string
	readonly mcpUrl: string
	readonly apiKey: string
}) => {
	const scratch = await mkdtemp(join(tmpdir(), "checkfu-user-journey-"))
	const project = join(scratch, "project")
	const consumer = join(scratch, "installed")
	const binary = join(consumer, "node_modules", "checkfu", "bin", "checkfu.mjs")
	const config = join(scratch, "config")
	const env = cliProcessEnv({ CHECKFU_CONFIG_DIR: config })
	const sdk = new Checkfu({ baseUrl: options.baseUrl, apiKey: options.apiKey, maxRetries: 0 })
	const mcp = new Client(
		{ name: "project-user", version: "1.0.0" },
		{ versionNegotiation: { mode: "auto" } },
	)
	const cli = async <T>(...args: ReadonlyArray<string>): Promise<T> => {
		const running = execute(process.execPath, [binary, "--format", "json", ...args], {
			cwd: project,
			env,
			timeout: 30_000,
		})
		running.child.stdin?.end()
		const result = await running
		return JSON.parse(result.stdout) as T
	}
	const call = async (params: CallToolRequestParams) => {
		const result = await mcp.callTool(params)
		expect(result.isError).not.toBe(true)
		return result.structuredContent
	}
	try {
		await mkdir(config)
		await writeFile(
			join(config, "config.json"),
			JSON.stringify({ url: options.baseUrl, api_key: options.apiKey }),
			{ mode: 0o600 },
		)
		const distribution = await buildCliPackage(join(scratch, "distribution"))
		const packed = await execute(
			"npm",
			["pack", distribution, "--pack-destination", scratch, "--ignore-scripts", "--json"],
			{ cwd: scratch, timeout: 30_000 },
		)
		const [{ filename }] = Schema.decodeSync(
			Schema.fromJsonString(Schema.Tuple([Schema.Struct({ filename: Schema.String })])),
		)(packed.stdout)
		await mkdir(consumer)
		await writeFile(join(consumer, "package.json"), '{"name":"installed-cli-user","private":true}')
		await execute(
			"npm",
			[
				"install",
				join(scratch, filename),
				"--ignore-scripts",
				"--offline",
				"--no-audit",
				"--no-fund",
			],
			{ cwd: consumer, timeout: 30_000 },
		)

		for (const dir of ["agents", "environments", "automations"]) {
			await mkdir(join(project, dir), { recursive: true })
		}
		const agentFile = join(project, "agents", "reporter.md")
		const environmentFile = join(project, "environments", "cloud.yaml")
		const automationFile = join(project, "automations", "report.yaml")
		await writeFile(agentFile, definition("Keep the original report instructions."))
		await writeFile(environmentFile, "name: Report environment\n")
		await writeFile(
			automationFile,
			[
				"name: Project report",
				"agent: ../agents/reporter.md",
				"environment_id: ../environments/cloud.yaml",
				"schedule: {type: cron, expression: '17 0 1 1 *', timezone: UTC}",
				"initial_events:",
				"  - type: user.message",
				"    content:",
				"      - {type: text, text: Create the release report.}",
			].join("\n"),
		)
		const info = await cli<{ readonly system: string }>("agent", "info", agentFile)
		expect(info.system).toBe("Keep the original report instructions.")
		const resourceIds = async () =>
			(await Promise.all([sdk.agents.list(), sdk.environments.list(), sdk.automations.list()])).map(
				(page) => page.data.map(({ id }) => id).toSorted(),
			)
		const beforePreview = await resourceIds()
		const preview = await cli<ReadonlyArray<PlanRow>>("apply", ".", "--dry-run")
		expect(preview.map((row) => row.action)).toEqual(["create", "create", "create"])
		expect(await resourceIds()).toEqual(beforePreview)
		await expect(readFile(join(project, "checkfu-lock.json"))).rejects.toMatchObject({
			code: "ENOENT",
		})
		const applied = await cli<ReadonlyArray<PlanRow>>("apply", ".", "--yes")
		const agentId = resourceId(applied, "./agents/reporter.md")
		const environmentId = resourceId(applied, "./environments/cloud.yaml")
		const automationId = resourceId(applied, "./automations/report.yaml")
		expect((await cli<ReadonlyArray<PlanRow>>("apply", "--yes")).map((row) => row.action)).toEqual([
			"unchanged",
			"unchanged",
			"unchanged",
		])
		await mcp.connect(
			new StreamableHTTPClientTransport(new URL(options.mcpUrl), {
				requestInit: { headers: { authorization: `Bearer ${options.apiKey}` } },
			}),
		)
		expect(mcp.getProtocolEra()).toBe("modern")
		await mcp.listTools()
		const path = { automation_id: automationId }
		const automation = decodeAutomation(
			await call({ name: "automations_getAutomation", arguments: { path } }),
		)
		expect(automation.agent).toEqual({ id: agentId, version: 1 })
		expect(automation.environment_id).toBe(environmentId)
		const queued = await cli<{ readonly run: number }>(
			"automations",
			"run",
			"--automation-id",
			automationId,
		)
		await expect
			.poll(async () => (await sdk.automations.runs.list(automationId)).data[0]?.session_id, {
				timeout: 10_000,
			})
			.toBeTruthy()
		const run = await sdk.automations.runs.retrieve(automationId, queued.run)
		expect(run.status).toBe("started")
		if (run.session_id === null) {
			throw new Error("The started run has no session")
		}
		const sessionId = run.session_id
		await expect
			.poll(
				async () => {
					const session = await sdk.sessions.retrieve(sessionId)
					return { status: session.status, turn: session.turn }
				},
				{ timeout: 30_000 },
			)
			.toEqual({ status: "idle", turn: 1 })
		const history = await sdk.sessions.events.list(sessionId)
		expect(history.data.filter((event) => event.type === "agent.tool_use")).toEqual([
			expect.objectContaining({
				name: "write",
				input: { path: "/mnt/session/outputs/report.csv", content: "region,total\nEMEA,4217\n" },
			}),
		])
		expect(history.data.filter((event) => event.type === "agent.tool_result")).toEqual([
			expect.objectContaining({ is_error: false }),
		])
		expect(history.data.filter((event) => event.type === "agent.message")).toHaveLength(1)
		await expect
			.poll(async () => (await sdk.sessions.outputs.retrieve(sessionId)).turn, { timeout: 10_000 })
			.toBe(1)
		const outputs = await sdk.sessions.outputs.retrieve(sessionId)
		expect(outputs.files.map((file) => file.filename)).toEqual(["report.csv"])
		const reportId = outputs.files[0]?.id ?? ""
		const reportText = async () => {
			const response = await fetch(`${options.baseUrl}/v1/files/${reportId}/content`, {
				headers: { authorization: `Bearer ${options.apiKey}` },
			})
			expect(response.status).toBe(200)
			return response.text()
		}
		expect(await reportText()).toBe("region,total\nEMEA,4217\n")
		await writeFile(agentFile, definition("Use the new report instructions."))
		await cli("apply", "--yes")
		const updated = decodeAutomation(
			await call({ name: "automations_getAutomation", arguments: { path } }),
		)
		expect(updated.agent).toEqual({ id: agentId, version: 2 })
		const pinned = await sdk.sessions.retrieve(sessionId)
		expect(pinned.agent.version).toBe(1)
		expect(pinned.agent.system).toBe("Keep the original report instructions.")
		const agentPath = { agent_id: agentId }
		await call({
			name: "agents_updateAgent",
			arguments: { path: agentPath, body: { version: 2, name: "A teammate's edit" } },
		})
		expect(
			(await cli<ReadonlyArray<PlanRow>>("apply", "--dry-run")).some(
				(row) => row.action === "blocked",
			),
		).toBe(true)
		const refused = await cli("apply", "--yes").then(
			() => {
				throw new Error("Apply overwrote a teammate without --force")
			},
			(error: unknown) => decodeExecError(error),
		)
		expect(refused.code).toBe(1)
		expect(refused.stderr).toContain("--force")
		expect((await sdk.agents.retrieve(agentId)).name).toBe("A teammate's edit")
		await cli("apply", "--yes", "--force")
		const before = await sdk.agents.retrieve(agentId)
		expect(before.name).toBe("Report writer")
		const [fromCli, fromMcp] = await Promise.all([
			cli<JsonAgent>(
				"agents",
				"update",
				"--agent-id",
				agentId,
				"--current-version",
				String(before.version),
				"--description",
				"CLI won",
			).then(
				(value) => ({ ok: true as const, value }),
				(error: unknown) => ({ ok: false as const, error }),
			),
			mcp.callTool({
				name: "agents_updateAgent",
				arguments: { path: agentPath, body: { version: before.version, description: "MCP won" } },
			}),
		])
		if (fromCli.ok) {
			expect(fromMcp.isError).toBe(true)
			const error = fromMcp.content[0]
			expect(error?.type).toBe("text")
			if (error?.type === "text") {
				expect(JSON.parse(error.text)).toMatchObject({ error: { type: "conflict_error" } })
			}
		} else {
			const error = decodeExecError(fromCli.error)
			expect(error.code).toBe(1)
			expect(error.stderr).toContain("409 conflict_error")
			expect(fromMcp.isError).not.toBe(true)
		}
		const winner = decodeAgent(
			await call({ name: "agents_getAgent", arguments: { path: agentPath } }),
		)
		expect(winner.version).toBe(before.version + 1)
		expect(winner.description).toBe(fromCli.ok ? "CLI won" : "MCP won")
		expect((await sdk.agents.retrieve(agentId, { version: 1 })).system).toBe(
			"Keep the original report instructions.",
		)
		// Restore the authored configuration before pruning; drift must not be silently overwritten by prune.
		await cli("apply", "--yes", "--force")
		expect(await sdk.agents.retrieve(agentId)).toMatchObject({
			name: "Report writer",
			description: null,
		})
		for (const file of [automationFile, agentFile, environmentFile]) {
			await unlink(file)
		}
		const removed = await cli<ReadonlyArray<PlanRow>>("apply", "--yes", "--prune")
		expect(removed.map((row) => row.action)).toEqual(["archive", "archive", "archive"])
		expect((await sdk.agents.retrieve(agentId)).archived_at).not.toBeNull()
		expect((await sdk.environments.retrieve(environmentId)).archived_at).not.toBeNull()
		expect(
			decodeAutomation(await call({ name: "automations_getAutomation", arguments: { path } }))
				.archived_at,
		).not.toBeNull()
		expect(await reportText()).toBe("region,total\nEMEA,4217\n")
		expect((await sdk.files.retrieve(reportId)).origin).toEqual({
			type: "session",
			session_id: sessionId,
			turn: 1,
			path: "report.csv",
		})
	} finally {
		await mcp.close()
		await rm(scratch, { recursive: true, force: true })
	}
}
