import { RETRY_EXIT_CODE, USAGE_EXIT_CODE } from "../src/Errors.ts"
import { IsSupportedAgentModel } from "@checkfu/api/Http/AgentsHandlers"
import { agentProjectFiles } from "@checkfu/authoring/document"
import { ProjectLockfile, formatProjectLockfile } from "@checkfu/authoring/lockfile"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import { makeTestServer } from "./helpers/CliHarness.ts"
import type { CliRunResult } from "./helpers/CliHarness.ts"

const makeProjectTestServer = () =>
	makeTestServer().pipe(
		Effect.provideService(IsSupportedAgentModel, (id) => id === "fixture-model"),
	)

const plan = (result: CliRunResult) => {
	expect(result.stderr).toBe("")
	expect(result.exitCode).toBe(0)
	return JSON.parse(result.stdout) as ReadonlyArray<{ file: string; action: string; id?: string }>
}

describe("YAML projects", () => {
	it("refuses duplicate owners in a project lock before reading or changing a resource", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const cli = yield* makeProjectTestServer()
					const fs = yield* FileSystem.FileSystem
					const path = yield* Path.Path
					const root = yield* fs.makeTempDirectoryScoped()
					const lock = path.join(root, "checkfu-lock.json")
					const active = "./agents/live.md"
					const missing = "./agents/removed.md"
					yield* fs.makeDirectory(path.join(root, "agents"))
					yield* fs.writeFileString(
						path.join(root, active),
						"---\nname: Maintained\nmodel: fixture-model\n---\n\nAnswer clearly.\n",
					)
					const apply = ["apply", "--lock-file", lock]
					const created = plan(
						yield* cli.run([...apply, "--yes", root], { fileSystem: NodeFileSystem.layer }),
					)
					expect(created).toMatchObject([{ file: active, action: "create" }])
					const settled = yield* Schema.decodeEffect(ProjectLockfile)(
						yield* fs.readFileString(lock),
					)
					const entry = settled.resources[active]
					if (entry === undefined) {
						throw new Error("The project did not record the agent")
					}
					const contents = formatProjectLockfile({
						...settled,
						resources: { ...settled.resources, [missing]: entry },
					})
					yield* fs.writeFileString(lock, contents)
					const requests: Array<string> = []
					for (const flags of [[], ["--dry-run"], ["--yes", "--prune", "--force"]]) {
						const result = yield* cli.run([...apply, ...flags, root], {
							fileSystem: NodeFileSystem.layer,
							interceptFetch: (next, request) => {
								requests.push(new URL(request.url).pathname)
								return next(request)
							},
						})
						expect(result.exitCode).toBe(USAGE_EXIT_CODE)
						expect(result.stderr).toContain(
							`agent ${entry.id} is owned by both ${active} and ${missing}.`,
						)
						expect(yield* fs.readFileString(lock)).toBe(contents)
					}
					expect(requests).toEqual([])
					expect(yield* fs.exists(`${lock}.apply-lock`)).toBe(false)
				}).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, Path.layer))),
			),
		)
	})

	it("validates locally, creates dependencies first, and reconciles the same resource IDs", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const cli = yield* makeProjectTestServer()
					const fs = yield* FileSystem.FileSystem
					const path = yield* Path.Path
					const root = yield* fs.makeTempDirectoryScoped()
					const lockFile = path.join(root, "checkfu-lock.json")
					const agentFile = path.join(root, "agents", "support.md")
					const envFile = path.join(root, "environments", "cloud.yaml")
					const automationFile = path.join(root, "automations", "report.md")
					for (const file of [agentFile, envFile, automationFile]) {
						yield* fs.makeDirectory(path.dirname(file))
					}
					const agent = (prompt: string) =>
						`---\nname: Support\nmodel: fixture-model\n---\n\n${prompt}\n`
					yield* fs.writeFileString(agentFile, agent("Answer directly."))
					yield* fs.writeFileString(envFile, "name: Cloud\n")
					const automationHeader = [
						"---",
						"name: Report",
						"agent: {path: ../agents/support.md}",
						"environment_id: ../environments/cloud.yaml",
						"schedule: {type: cron, expression: '0 9 * * 1-5', timezone: UTC}",
					].join("\n")
					yield* fs.writeFileString(
						automationFile,
						[
							automationHeader,
							"initial_events:",
							"  - type: user.message",
							"    content:",
							"      - {type: text, text: Write the report.}",
							"      - {type: text, text: Cite the source.}",
							"---",
						].join("\n"),
					)
					const fileSystem = NodeFileSystem.layer
					const apply = (...args: Array<string>) =>
						cli.run(["apply", "--lock-file", lockFile, ...args], { fileSystem })

					const info = yield* cli.run(["agent", "info", agentFile], { fileSystem, env: {} })
					expect(info.exitCode).toBe(0)
					expect(JSON.parse(info.stdout)).toEqual({
						name: "Support",
						model: "fixture-model",
						system: "Answer directly.",
					})

					yield* fs.writeFileString(
						agentFile,
						"---\nname: Legacy\nmodel: fixture-model\nharness: pi\n---\n",
					)
					const invalid = yield* apply("--yes", automationFile)
					expect(invalid.exitCode).toBe(USAGE_EXIT_CODE)
					expect(invalid.stderr).toContain("./agents/support.md")
					expect(invalid.stderr).toContain("harness")
					expect(yield* fs.exists(lockFile)).toBe(false)
					yield* fs.writeFileString(agentFile, agent("Answer directly."))

					const preview = plan(yield* apply("--dry-run", root))
					expect(preview).toMatchObject([
						{ file: "./agents/support.md", action: "create" },
						{ file: "./environments/cloud.yaml", action: "create" },
						{ file: "./automations/report.md", action: "create" },
					])
					expect(yield* fs.exists(lockFile)).toBe(false)
					const needsConfirmation = yield* apply(automationFile)
					expect(needsConfirmation.stderr).toContain("--yes")
					expect(yield* fs.exists(lockFile)).toBe(false)

					expect(
						plan(yield* apply("--yes", automationFile)).map(({ file, action }) => ({
							file,
							action,
						})),
					).toMatchObject(preview.map(({ file, action }) => ({ file, action })))
					const unchanged = plan(yield* apply())
					expect(unchanged.map(({ action }) => action)).toEqual([
						"unchanged",
						"unchanged",
						"unchanged",
					])
					const agentId = unchanged[0]?.id ?? ""
					const environmentId = unchanged[1]?.id ?? ""
					const automationId = unchanged[2]?.id ?? ""
					const automation = yield* cli.run([
						"automations",
						"retrieve",
						"--automation-id",
						automationId,
					])
					expect(JSON.parse(automation.stdout)).toMatchObject({
						agent: { id: agentId, version: 1 },
						environment_id: environmentId,
						initial_events: [{ content: [{ text: "Write the report.\nCite the source." }] }],
					})

					yield* fs.writeFileString(
						automationFile,
						`${automationHeader}\n---\n\nWrite the report.\nCite the source.\n`,
					)
					expect(plan(yield* apply("--dry-run", automationFile)).at(-1)).toMatchObject({
						action: "unchanged",
					})

					yield* fs.writeFileString(agentFile, agent("Explain your answer."))
					const updatePreview = plan(yield* apply("--dry-run", automationFile))
					expect(updatePreview[0]).toMatchObject({
						changes: { system: { from: "Answer directly.", to: "Explain your answer." } },
					})
					expect(updatePreview.at(-1)).toMatchObject({
						changes: { agent: { to: { type: "agent", id: agentId, version: 2 } } },
					})
					let automationUpdate: unknown
					const updatedTogether = plan(
						yield* cli.run(["apply", "--lock-file", lockFile, "--yes", automationFile], {
							fileSystem,
							interceptFetch: async (next, request) => {
								if (
									request.method === "POST" &&
									new URL(request.url).pathname === `/v1/automations/${automationId}`
								) {
									automationUpdate = await request.clone().json()
								}
								return next(request)
							},
						}),
					)
					expect(updatedTogether[0]).toEqual({
						file: "./agents/support.md",
						action: "update",
						id: agentId,
						fields: ["system"],
					})
					expect(updatedTogether.at(-1)).toMatchObject({
						file: "./automations/report.md",
						action: "update",
						fields: ["agent"],
					})
					expect(automationUpdate).toEqual({
						agent: { type: "agent", id: agentId, version: 2 },
						revision: 1,
					})
					const repinned = yield* cli.run([
						"automations",
						"retrieve",
						"--automation-id",
						automationId,
					])
					expect(JSON.parse(repinned.stdout)).toMatchObject({ agent: { id: agentId, version: 2 } })

					const outOfBand = yield* cli.run([
						"agents",
						"update",
						"--agent-id",
						agentId,
						"--current-version",
						"2",
						"--name",
						"Remote edits",
					])
					expect(outOfBand.exitCode).toBe(0)
					expect(plan(yield* apply("--dry-run", agentFile))[0]).toMatchObject({
						action: "blocked",
						id: agentId,
						changes: { name: { from: "Remote edits", to: "Support" } },
					})
					expect(plan(yield* apply("--yes", "--force", agentFile))[0]).toMatchObject({
						action: "update",
						id: agentId,
					})

					yield* fs.remove(automationFile)
					expect(plan(yield* apply("--yes", "--prune")).at(-1)).toEqual({
						file: "./automations/report.md",
						action: "archive",
						id: automationId,
					})
					const archived = yield* cli.run([
						"automations",
						"retrieve",
						"--automation-id",
						automationId,
					])
					expect(JSON.parse(archived.stdout)).toMatchObject({ status: "archived" })
					expect(yield* fs.exists(`${lockFile}.apply-lock`)).toBe(false)
				}).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, Path.layer))),
			),
		)
	})

	it("applies a dashboard export to the same agent ID", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const cli = yield* makeProjectTestServer()
					const fs = yield* FileSystem.FileSystem
					const path = yield* Path.Path
					const root = yield* fs.makeTempDirectoryScoped()
					const mcpServers = [{ type: "url", name: "reports", url: "https://reports.example/mcp" }]
					const tools = [{ type: "mcp_toolset", mcp_server_name: "reports" }]
					const made = yield* cli.run([
						"agents",
						"create",
						"--name",
						"Exported agent",
						"--model",
						"fixture-model",
						"--system",
						"Write the report.\nCite sources.",
						"--mcp-servers",
						JSON.stringify(mcpServers),
						"--tools",
						JSON.stringify(tools),
					])
					expect(made.exitCode).toBe(0)
					const agent = JSON.parse(made.stdout) as {
						id: string
						name: string
						model: { id: string }
					}
					const project = yield* Effect.promise(() =>
						agentProjectFiles(agent, "http://localhost:1337"),
					)
					for (const [file, text] of Object.entries(project.files)) {
						const dest = path.join(root, file)
						yield* fs.makeDirectory(path.dirname(dest), { recursive: true })
						yield* fs.writeFileString(dest, text)
					}
					const apply = (...args: Array<string>) =>
						cli.run(["apply", "--lock-file", path.join(root, "checkfu-lock.json"), ...args], {
							fileSystem: NodeFileSystem.layer,
						})
					expect(plan(yield* apply("--dry-run"))[0]).toMatchObject({
						action: "unchanged",
						id: agent.id,
					})
					const source = path.join(root, project.definitionFile)
					const markdown = yield* fs.readFileString(source)
					yield* fs.writeFileString(source, markdown.replaceAll("\n", "\r\n"))
					expect(plan(yield* apply("--dry-run"))[0]).toMatchObject({
						action: "unchanged",
						id: agent.id,
					})
					yield* fs.writeFileString(
						source,
						markdown.replace("Write the report.\nCite sources.", "Answer briefly."),
					)
					expect(plan(yield* apply("--yes"))[0]).toMatchObject({ action: "update", id: agent.id })
					const updated = yield* cli.run(["agents", "retrieve", "--agent-id", agent.id])
					expect(JSON.parse(updated.stdout)).toMatchObject({
						id: agent.id,
						version: 2,
						system: "Answer briefly.",
						mcp_servers: mcpServers,
						tools,
					})
				}).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, Path.layer))),
			),
		)
	})

	it("reuses the original create request after the deployment commits and the response is lost", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const cli = yield* makeProjectTestServer()
					const fs = yield* FileSystem.FileSystem
					const path = yield* Path.Path
					const root = yield* fs.makeTempDirectoryScoped()
					const lockFile = path.join(root, "checkfu-lock.json")
					const file = path.join(root, "agent.yaml")
					yield* fs.writeFileString(file, "name: Support\nmodel: fixture-model\n")
					const keys: Array<string | null> = []
					const attempts = ["apply", "--yes", "--lock-file", lockFile, file]
					const options = {
						fileSystem: NodeFileSystem.layer,
						interceptFetch: async (
							next: (request: Request) => Promise<Response>,
							request: Request,
						) => {
							if (request.method !== "POST") {
								return next(request)
							}
							keys.push(request.headers.get("Idempotency-Key"))
							const response = await next(request)
							if (keys.length === 1) {
								expect(response.status).toBe(201)
								throw new Error("lost response")
							}
							return response
						},
					}
					expect((yield* cli.run(attempts, options)).exitCode).toBe(RETRY_EXIT_CODE)
					const pendingText = yield* fs.readFileString(lockFile)
					const pendingLock = yield* Schema.decodeEffect(ProjectLockfile)(pendingText)
					const original = "./agent.yaml"
					const copied = "./copy.yaml"
					const pending = pendingLock.pending_creates?.[original]
					if (pending === undefined) {
						throw new Error("The lock did not retain the pending create")
					}
					const duplicatePending = formatProjectLockfile({
						...pendingLock,
						pending_creates: { [original]: pending, [copied]: pending },
					})
					yield* fs.writeFileString(lockFile, duplicatePending)
					const duplicate = yield* cli.run(attempts, options)
					expect(duplicate.exitCode).toBe(USAGE_EXIT_CODE)
					expect(duplicate.stderr).toContain(`is owned by both ${original} and ${copied}.`)
					expect(yield* fs.readFileString(lockFile)).toBe(duplicatePending)
					expect(keys).toHaveLength(1)
					yield* fs.writeFileString(lockFile, pendingText)
					yield* fs.writeFileString(file, "name: Different\nmodel: fixture-model\n")
					expect((yield* cli.run(attempts, options)).stderr).toContain("awaiting confirmation")
					yield* fs.writeFileString(file, "name: Support\nmodel: fixture-model\n")
					expect(plan(yield* cli.run(attempts, options))[0]?.action).toBe("create")
					expect(keys).toHaveLength(2)
					expect(keys[0]).toMatch(/^cli_/)
					expect(keys[1]).toBe(keys[0])
					expect(JSON.parse(yield* fs.readFileString(lockFile))).not.toHaveProperty(
						"pending_creates",
					)
					const settled = yield* Schema.decodeEffect(ProjectLockfile)(
						yield* fs.readFileString(lockFile),
					)
					const id = settled.resources[original]?.id
					if (id === undefined) {
						throw new Error("The original path did not settle")
					}
					yield* fs.rename(file, path.join(root, copied))
					const copiedPending = formatProjectLockfile({
						...settled,
						pending_creates: { [copied]: pending },
					})
					yield* fs.writeFileString(lockFile, copiedPending)
					const outcome = yield* cli.run(
						["apply", "--yes", "--prune", "--force", "--lock-file", lockFile, root],
						options,
					)
					expect(outcome.exitCode).toBe(USAGE_EXIT_CODE)
					expect(outcome.stderr).toContain(`agent ${id}, already owned by ${original}.`)
					expect(yield* fs.readFileString(lockFile)).toBe(copiedPending)
					const retrieved = yield* cli.run(["agents", "retrieve", "--agent-id", id])
					expect(JSON.parse(retrieved.stdout)).toMatchObject({ id, archived_at: null })
				}).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, Path.layer))),
			),
		)
	})
})
