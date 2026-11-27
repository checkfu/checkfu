import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schedule from "effect/Schedule"
import * as Stream from "effect/Stream"
import { MAX_ARTIFACT_BODY_BYTES, MAX_INLINE_FILE_BYTES } from "@checkfu/sdk/Schemas"
import { MAX_INPUT_BYTES } from "../src/Input.ts"
import { TEST_API_KEY, makeTestServer } from "./helpers/CliHarness.ts"
import type { CliRunResult } from "./helpers/CliHarness.ts"

const listedIds = (result: CliRunResult): ReadonlyArray<string> =>
	result.exitCode === 0
		? (JSON.parse(result.stdout) as { data: ReadonlyArray<{ id: string }> }).data.map(
				(entry) => entry.id,
			)
		: []

const untilListed = <E, R>(run: Effect.Effect<CliRunResult, E, R>, id: string) =>
	run.pipe(
		Effect.repeat({
			schedule: Schedule.spaced("5 millis"),
			times: 200,
			until: (result) => listedIds(result).includes(id),
		}),
		Effect.map(listedIds),
	)

describe("CLI help, errors, and resource commands", () => {
	it("renders help without requiring credentials and omits any beta prefix", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const cli = yield* makeTestServer()

					const rootHelp = yield* cli.run(["--help"], { env: {} })
					expect(rootHelp.exitCode).toBe(0)
					expect(rootHelp.stderr).toBe("")
					expect(rootHelp.stdout).toContain("agents")
					expect(rootHelp.stdout).toContain("environments")
					expect(rootHelp.stdout).toContain("sessions")
					expect(rootHelp.stdout).toContain("sessions:events")
					expect(rootHelp.stdout.toLowerCase()).not.toContain("beta")

					const eventsHelp = yield* cli.run(["sessions:events", "--help"], { env: {} })
					expect(eventsHelp.exitCode).toBe(0)
					expect(eventsHelp.stderr).toBe("")
					expect(eventsHelp.stdout).toContain("send")
					expect(eventsHelp.stdout).toContain("list")
					expect(eventsHelp.stdout).toContain("stream")
					expect(eventsHelp.stdout.toLowerCase()).not.toContain("beta")

					const agentCreateHelp = yield* cli.run(["agents", "create", "--help"], { env: {} })
					expect(agentCreateHelp.exitCode).toBe(0)
					expect(agentCreateHelp.stdout).toContain("@file")
					expect(agentCreateHelp.stdout).toContain("YAML")

					const eventsListHelp = yield* cli.run(["sessions:events", "list", "--help"], { env: {} })
					expect(eventsListHelp.exitCode).toBe(0)
					expect(eventsListHelp.stdout).toContain("--page")
					expect(eventsListHelp.stdout).toContain("desc")

					const rootVer = yield* cli.run(["--version"], { env: {} })
					expect(rootVer.exitCode).toBe(0)
					expect(rootVer.stdout.trim()).toMatch(/^checkfu v\d+\.\d+\.\d+/)
					for (const cmd of [
						["agents", "update", "--version"],
						["environments", "update", "--version"],
					]) {
						const ver = yield* cli.run(cmd, { env: {} })
						expect(ver.exitCode).toBe(0)
						expect(ver.stderr).toBe("")
						expect(ver.stdout.trim()).toBe(rootVer.stdout.trim())
					}
					const agentUpdateHelp = yield* cli.run(["agents", "update", "--help"], { env: {} })
					expect(agentUpdateHelp.exitCode).toBe(0)
					expect(agentUpdateHelp.stdout).toContain("--current-version")
				}),
			),
		)
	})

	it("rejects a YAML stream passed to a resource command", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const cli = yield* makeTestServer()
					const result = yield* cli.run(["environments", "create"], {
						stdin: "name: First\n---\nname: Second\n",
					})
					expect(result.exitCode).toBe(1)
					expect(result.stderr).toContain("multiple documents")
					expect(result.stdout).toBe("")
				}),
			),
		)
	})

	it("writes parse, config, and auth errors strictly to stderr with empty stdout", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const cli = yield* makeTestServer()

					const unknown = yield* cli.run(["unknown-cmd"])
					expect(unknown.exitCode).toBe(1)
					expect(unknown.stdout).toBe("")
					expect(unknown.stderr).toContain("unknown-cmd")

					const missingKey = yield* cli.run(["agents", "retrieve", "--agent-id", "agt_123"], {
						env: {},
					})
					expect(missingKey.exitCode).toBe(1)
					expect(missingKey.stdout).toBe("")
					expect(missingKey.stderr).toContain("CHECKFU_API_KEY")

					const badKey = yield* cli.run(["agents", "retrieve", "--agent-id", "agt_123"], {
						env: { CHECKFU_API_KEY: "wrong-key" },
					})
					expect(badKey.exitCode).toBe(1)
					expect(badKey.stdout).toBe("")
					expect(badKey.stderr).toContain("401 authentication_error")

					const ttyInvalid = yield* cli.run(["agents", "bad\u001b]52;c;evil\u0007cmd"], {
						stderrIsTerminal: true,
					})
					expect(ttyInvalid.exitCode).toBe(1)
					expect(ttyInvalid.stdout).toBe("")
					expect(ttyInvalid.stderr).toContain("ERROR")
					expect(ttyInvalid.stderr).not.toContain(String.raw`\x1b[1m`)
					expect(ttyInvalid.stderr).not.toContain("\u001b")
					expect(ttyInvalid.stderr).not.toContain("\u0007")

					const blankUrl = yield* cli.run([
						"environments",
						"delete",
						"--base-url",
						"",
						"--environment-id",
						"env_123",
					])
					expect(blankUrl.exitCode).toBe(1)
					expect(blankUrl.stdout).toBe("")
					expect(blankUrl.stderr).toContain("API base URL must not be empty")

					for (const badId of [".", "..", "foo/bar"]) {
						const badAgentPath = yield* cli.run(["agents", "retrieve", "--agent-id", badId])
						expect(badAgentPath.exitCode).toBe(1)
						expect(badAgentPath.stdout).toBe("")
						expect(badAgentPath.stderr).toContain("Invalid --agent-id")

						const badSessionPath = yield* cli.run(["sessions", "connect", "--session-id", badId])
						expect(badSessionPath.exitCode).toBe(1)
						expect(badSessionPath.stdout).toBe("")
						expect(badSessionPath.stderr).toContain("Invalid --session-id")
					}
				}),
			),
		)
	})

	it("manages full agent lifecycle via flags, @file, JSON/YAML stdin, and --transform", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const cli = yield* makeTestServer()

					const createdRaw = yield* cli.run(
						[
							"agents",
							"create",
							"--name",
							"Alpha",
							"--model",
							'{"id":"gpt-6.2-sol"}',
							"--system",
							"@prompt.txt",
							"--transform",
							"id",
							"-r",
						],
						{ files: { "prompt.txt": "Be concise." } },
					)
					expect(createdRaw.exitCode).toBe(0)
					expect(createdRaw.stderr).toBe("")
					const agentId = createdRaw.stdout.trim()
					expect(agentId).toMatch(/^agent_/)

					const retrievedYaml = yield* cli.run([
						"--format",
						"yaml",
						"agents",
						"retrieve",
						"--agent-id",
						agentId,
					])
					expect(retrievedYaml.exitCode).toBe(0)
					expect(retrievedYaml.stdout).toContain(`id: ${agentId}`)
					expect(retrievedYaml.stdout).toContain("system: Be concise.")
					expect(retrievedYaml.stdout).toContain("version: 1")

					const updated = yield* cli.run([
						"agents",
						"update",
						"--agent-id",
						agentId,
						"--current-version",
						"1",
						"--name",
						"Alpha v2",
						"--transform",
						"{id,name,version}",
					])
					expect(updated.exitCode).toBe(0)
					expect(JSON.parse(updated.stdout)).toEqual({
						id: agentId,
						name: "Alpha v2",
						version: 2,
					})

					const conflict = yield* cli.run([
						"agents",
						"update",
						"--agent-id",
						agentId,
						"--current-version",
						"1",
						"--name",
						"Stale",
					])
					expect(conflict.exitCode).toBe(1)
					expect(conflict.stdout).toBe("")
					expect(conflict.stderr).toContain("409")

					const archived = yield* cli.run(["agents", "archive", "--agent-id", agentId])
					expect(archived.exitCode).toBe(0)
					expect(JSON.parse(archived.stdout).archived_at).not.toBeNull()
					expect(
						yield* untilListed(cli.run(["agents", "list", "--include-archived", "true"]), agentId),
					).toContain(agentId)
					const defaultList = yield* cli.run(["agents", "list"])
					expect(defaultList.exitCode).toBe(0)
					expect(listedIds(defaultList)).not.toContain(agentId)

					const fromYaml = yield* cli.run(["agents", "create", "--name", "OverrideName"], {
						stdin: "name: Original\nmodel: claude-sonnet-5-5\ndescription: From YAML\n",
					})
					expect(fromYaml.exitCode).toBe(0)
					const parsed = JSON.parse(fromYaml.stdout) as {
						name: string
						model: { id: string }
						description: string
					}
					expect(parsed.name).toBe("OverrideName")
					expect(parsed.model.id).toBe("claude-sonnet-5-5")
					expect(parsed.description).toBe("From YAML")
				}),
			),
		)
	})

	it("manages full environment lifecycle including config JSON, archive, and delete", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const cli = yield* makeTestServer()

					const created = yield* cli.run([
						"environments",
						"create",
						"--name",
						"dev-box",
						"--config",
						'{"type":"cloud","networking":{"type":"unrestricted"}}',
					])
					expect(created.exitCode).toBe(0)
					const env = JSON.parse(created.stdout) as { id: string; version: number; name: string }
					expect(env.id).toMatch(/^env_/)
					expect(env.name).toBe("dev-box")
					expect(env.version).toBe(1)

					const retrieved = yield* cli.run([
						"environments",
						"retrieve",
						"--environment-id",
						env.id,
						"--base-url",
						"http://localhost:1337/v1",
					])
					expect(retrieved.exitCode).toBe(0)
					expect(JSON.parse(retrieved.stdout).id).toBe(env.id)

					const updated = yield* cli.run([
						"environments",
						"update",
						"--environment-id",
						env.id,
						"--current-version",
						"1",
						"--description",
						"Updated env",
					])
					expect(updated.exitCode).toBe(0)
					expect(JSON.parse(updated.stdout).description).toBe("Updated env")
					expect(
						yield* untilListed(
							cli.run(["environments", "list", "--order", "desc", "--limit", "5"]),
							env.id,
						),
					).toEqual([env.id])

					const archived = yield* cli.run(["environments", "archive", "--environment-id", env.id])
					expect(archived.exitCode).toBe(0)
					expect(JSON.parse(archived.stdout).archived_at).not.toBeNull()

					const deleted = yield* cli.run(["environments", "delete", "--environment-id", env.id])
					expect(deleted.exitCode).toBe(0)
					expect(JSON.parse(deleted.stdout)).toEqual({
						id: env.id,
						type: "environment_deleted",
					})
				}),
			),
		)
	})

	it("manages an automation with the documented flags: create, pause, run, list runs, archive", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const cli = yield* makeTestServer()
					const agent = JSON.parse(
						(yield* cli.run(["agents", "create", "--name", "Reporter", "--model", "gpt-4o-mini"]))
							.stdout,
					) as { id: string }
					const env = JSON.parse(
						(yield* cli.run(["environments", "create", "--name", "Cloud"])).stdout,
					) as { id: string }

					const created = yield* cli.run([
						"automations",
						"create",
						"--name",
						"Morning report",
						"--agent",
						agent.id,
						"--environment-id",
						env.id,
						"--initial-event",
						'{"type":"user.message","content":[{"type":"text","text":"Write the morning report."}]}',
						"--schedule",
						'{"type":"cron","expression":"0 9 * * 1-5","timezone":"America/New_York"}',
					])
					expect(created.stderr).toMatch(/^Idempotency-Key: \S+\n$/u)
					expect(created.exitCode).toBe(0)
					const automation = JSON.parse(created.stdout) as {
						id: string
						status: string
						initial_events: ReadonlyArray<{ content: ReadonlyArray<{ text: string }> }>
						upcoming_runs_at: ReadonlyArray<string>
					}
					expect(automation.id).toMatch(/^auto_/)
					expect(automation.status).toBe("active")
					expect(automation.initial_events[0]?.content[0]?.text).toBe("Write the morning report.")
					expect(automation.upcoming_runs_at).toHaveLength(5)

					const twoEvents = yield* cli.run([
						"automations",
						"create",
						"--name",
						"Two",
						"--agent",
						agent.id,
						"--environment-id",
						env.id,
						"--initial-event",
						'{"type":"user.message","content":[{"type":"text","text":"a"}]}',
						"--initial-event",
						'{"type":"user.message","content":[{"type":"text","text":"b"}]}',
						"--schedule",
						'{"type":"cron","expression":"0 9 * * *","timezone":"UTC"}',
					])
					expect(twoEvents.exitCode).toBe(1)
					expect(twoEvents.stdout).toBe("")

					const id = ["--automation-id", automation.id]
					const paused = yield* cli.run(["automations", "pause", ...id])
					expect(paused.exitCode).toBe(0)
					expect(JSON.parse(paused.stdout).status).toBe("paused")

					const ran = yield* cli.run(["automations", "run", ...id])
					expect(ran.exitCode).toBe(0)
					expect(JSON.parse(ran.stdout)).toMatchObject({
						run: 1,
						status: "queued",
						trigger: { type: "manual" },
					})

					const runs = yield* cli.run(["automations:runs", "list", ...id, "--limit", "5"])
					expect(runs.exitCode).toBe(0)
					expect(JSON.parse(runs.stdout)).toHaveProperty("data")

					const listed = yield* cli.run(["automations", "list", "--limit", "5"])
					expect(listed.exitCode).toBe(0)
					expect(
						(JSON.parse(listed.stdout) as { data: ReadonlyArray<{ id: string }> }).data.map(
							(entry) => entry.id,
						),
					).toContain(automation.id)

					const unpaused = yield* cli.run(["automations", "unpause", ...id])
					expect(JSON.parse(unpaused.stdout).status).toBe("active")
					const renamed = yield* cli.run(["automations", "update", ...id, "--name", "Renamed"], {
						stdin: "{}",
					})
					expect([renamed.exitCode, renamed.stderr]).toEqual([0, ""])
					expect(JSON.parse(renamed.stdout)).toMatchObject({
						name: "Renamed",
						initial_events: [
							{
								type: "user.message",
								content: [{ type: "text", text: "Write the morning report." }],
							},
						],
					})
					const retrieved = yield* cli.run(["automations", "retrieve", ...id])
					expect(JSON.parse(retrieved.stdout).run_count).toBe(1)
					const archived = yield* cli.run(["automations", "archive", ...id])
					expect(archived.exitCode).toBe(0)
					expect(JSON.parse(archived.stdout).status).toBe("archived")
				}),
			),
		)
	})

	it("manages sessions and diagnoses missing agent vs missing environment on 404", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const cli = yield* makeTestServer()

					const agentId = (yield* cli.run([
						"agents",
						"create",
						"--name",
						"Coder",
						"--model",
						"gpt-6.2-sol",
						"--transform",
						"id",
						"-r",
					])).stdout.trim()
					const envId = (yield* cli.run([
						"environments",
						"create",
						"--name",
						"sandbox",
						"--transform",
						"id",
						"-r",
					])).stdout.trim()

					const badAgent = yield* cli.run([
						"sessions",
						"create",
						"--agent",
						"agt_missing_agent",
						"--environment-id",
						envId,
					])
					expect(badAgent.exitCode).toBe(1)
					expect(badAgent.stderr).toContain('Agent "agt_missing_agent" was not found.')

					const badEnv = yield* cli.run([
						"sessions",
						"create",
						"--agent",
						agentId,
						"--environment-id",
						"env_missing_env",
					])
					expect(badEnv.exitCode).toBe(1)
					expect(badEnv.stderr).toContain('Environment "env_missing_env" was not found.')

					for (const badArgs of [
						["sessions", "create", "--agent", "..", "--environment-id", envId],
						["sessions", "create", "--agent", agentId, "--environment-id", ".."],
						["sessions", "create", "--agent", ".", "--environment-id", ".."],
					]) {
						const dotRes = yield* cli.run(badArgs)
						expect(dotRes.exitCode).toBe(1)
						expect(dotRes.stdout).toBe("")
						expect(dotRes.stderr).toContain("404 not_found_error")
						expect(dotRes.stderr).not.toContain("Unexpected error")
						expect(dotRes.stderr).not.toContain("Invalid path parameter")
					}

					const created = yield* cli.run(
						[
							"sessions",
							"create",
							"--agent",
							`{"type":"agent","id":"${agentId}","version":1}`,
							"--environment-id",
							envId,
							"--title",
							"CLI Session",
						],
						{
							env: { CHECKFU_API_KEY: TEST_API_KEY, CHECKFU_BASE_URL: "http://localhost:1337" },
						},
					)
					expect(created.exitCode).toBe(0)
					const session = JSON.parse(created.stdout) as {
						id: string
						agent: { id: string; version: number }
						environment_id: string
						title: string
						status: string
					}
					expect(session.id).toMatch(/^sess_/)
					expect(session.agent).toMatchObject({ type: "agent", id: agentId, version: 1 })
					expect(session.environment_id).toBe(envId)
					expect(session.title).toBe("CLI Session")
					expect(session.status).toBe("idle")

					const retrieved = yield* cli.run(["sessions", "retrieve", "--session-id", session.id])
					expect(retrieved.exitCode).toBe(0)
					expect(JSON.parse(retrieved.stdout).id).toBe(session.id)
					expect(
						yield* untilListed(cli.run(["sessions", "list", "--agent-id", agentId]), session.id),
					).toContain(session.id)

					const archived = yield* cli.run(["sessions", "archive", "--session-id", session.id])
					expect(archived.exitCode).toBe(0)
					expect(JSON.parse(archived.stdout).status).toBe("terminated")
				}),
			),
		)
	})

	it("strips trailing newlines from @file model and agent identifiers while preserving free-text whitespace", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const cli = yield* makeTestServer()

					const createdAgent = yield* cli.run(
						[
							"agents",
							"create",
							"--name",
							"FileIdAgent",
							"--model",
							"@model.txt",
							"--system",
							"@prompt.txt",
						],
						{
							files: {
								"model.txt": "gpt-6.2-sol\n",
								"prompt.txt": "  Keep leading and trailing whitespace.\n\n",
							},
						},
					)
					expect(createdAgent.exitCode).toBe(0)
					const agent = JSON.parse(createdAgent.stdout) as {
						id: string
						model: { id: string }
						system: string
					}
					expect(agent.model.id).toBe("gpt-6.2-sol")
					expect(agent.system).toBe("  Keep leading and trailing whitespace.\n\n")

					const envId = (yield* cli.run([
						"environments",
						"create",
						"--name",
						"file-id-env",
						"--transform",
						"id",
						"-r",
					])).stdout.trim()

					const createdSession = yield* cli.run(
						["sessions", "create", "--agent", "@agent-id.txt", "--environment-id", envId],
						{ files: { "agent-id.txt": `${agent.id}\r\n` } },
					)
					expect(createdSession.exitCode).toBe(0)
					const session = JSON.parse(createdSession.stdout) as { agent: { id: string } }
					expect(session.agent.id).toBe(agent.id)

					const quotedModelAgent = yield* cli.run([
						"agents",
						"create",
						"--name",
						"QuotedYamlModel",
						"--model",
						'"id": gpt-6.2-sol',
					])
					expect(quotedModelAgent.exitCode).toBe(0)
					expect((JSON.parse(quotedModelAgent.stdout) as { model: { id: string } }).model.id).toBe(
						"gpt-6.2-sol",
					)

					const quotedModelFileAgent = yield* cli.run(
						["agents", "create", "--name", "QuotedYamlModelFile", "--model", "@model.yaml"],
						{ files: { "model.yaml": "'id': gpt-6.2-sol\n" } },
					)
					expect(quotedModelFileAgent.exitCode).toBe(0)
					expect(
						(JSON.parse(quotedModelFileAgent.stdout) as { model: { id: string } }).model.id,
					).toBe("gpt-6.2-sol")

					const quotedAgentSession = yield* cli.run([
						"sessions",
						"create",
						"--agent",
						`"type": agent\n"id": ${agent.id}`,
						"--environment-id",
						envId,
					])
					expect(quotedAgentSession.exitCode).toBe(0)
					expect(
						(JSON.parse(quotedAgentSession.stdout) as { agent: { id: string } }).agent.id,
					).toBe(agent.id)

					const quotedAgentFileSession = yield* cli.run(
						["sessions", "create", "--agent", "@agent.yaml", "--environment-id", envId],
						{ files: { "agent.yaml": `"type": agent\n"id": ${agent.id}\n` } },
					)
					expect(quotedAgentFileSession.exitCode).toBe(0)
					expect(
						(JSON.parse(quotedAgentFileSession.stdout) as { agent: { id: string } }).agent.id,
					).toBe(agent.id)

					const typoTopLevel = yield* cli.run(["environments", "create"], {
						stdin: "name: typo-env\nconfg:\n  type: cloud\n",
					})
					expect(typoTopLevel.exitCode).toBe(1)
					expect(typoTopLevel.stdout).toBe("")
					expect(typoTopLevel.stderr).toContain("confg")

					const typoNested = yield* cli.run(["environments", "create"], {
						stdin:
							"name: typo-env\nconfig:\n  type: cloud\n  netwroking:\n    type: unrestricted\n",
					})
					expect(typoNested.exitCode).toBe(1)
					expect(typoNested.stdout).toBe("")
					expect(typoNested.stderr).toContain("netwroking")

					const leakedWarnings: Array<string> = []
					const onWarning = (warning: Error) => {
						leakedWarnings.push(warning.message)
					}
					process.on("warning", onWarning)
					try {
						const warnedYaml = yield* cli.run(["agents", "create"], {
							stdin: "name: !custom_tag Safe\u001b]52;c;evil\u0007Name\nmodel: gpt-6.2-sol\n",
						})
						expect(warnedYaml.exitCode).toBe(0)
						expect(leakedWarnings).toEqual([])
						expect(warnedYaml.stderr).toContain("Warning (stdin):")
						expect(warnedYaml.stderr).toContain("Unresolved tag")
						expect(warnedYaml.stderr).not.toContain("\u001b")
						expect(warnedYaml.stderr).not.toContain("\u0007")
					} finally {
						process.off("warning", onWarning)
					}

					const redirectedUpdate = yield* cli.run(
						[
							"agents",
							"update",
							"--agent-id",
							agent.id,
							"--current-version",
							"1",
							"--name",
							"ShouldNotSucceed",
						],
						{
							interceptFetch: async (_next, _request) =>
								new Response(null, {
									status: 302,
									headers: { location: `/v1/agents/${agent.id}` },
								}),
						},
					)
					expect(redirectedUpdate.exitCode).toBe(1)
					expect(redirectedUpdate.stdout).toBe("")
					expect(redirectedUpdate.stderr).toContain("302")

					const fileChunk64k = new TextEncoder().encode("x".repeat(64 * 1024))
					let fileChunksPulled = 0
					const hugeVirtualFile = Stream.unfold(0, (n) =>
						Effect.sync(() => {
							fileChunksPulled++
							return [fileChunk64k, n + 1] as const
						}),
					)
					const hugeFileAgent = yield* cli.run(
						[
							"agents",
							"create",
							"--name",
							"TooBig",
							"--model",
							"gpt-6.2-sol",
							"--system",
							"@huge.txt",
						],
						{ files: { "huge.txt": hugeVirtualFile } },
					)
					expect(hugeFileAgent.exitCode).toBe(1)
					expect(hugeFileAgent.stdout).toBe("")
					expect(hugeFileAgent.stderr).toContain("exceeds 2097152 byte limit")
					expect(fileChunksPulled).toBeLessThanOrEqual(35)
				}),
			),
		)
	})

	it("rejects invalid UTF-8 in @file and stdin inputs before issuing API requests", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const cli = yield* makeTestServer()
					const encoder = new TextEncoder()

					let fileRequests = 0
					const badFileRes = yield* cli.run(
						[
							"agents",
							"create",
							"--name",
							"BadUtf8File",
							"--model",
							"gpt-6.2-sol",
							"--system",
							"@bad-utf8.txt",
						],
						{
							files: {
								"bad-utf8.txt": Stream.make(new Uint8Array([0x68, 0x69, 0xff, 0x21])),
							},
							interceptFetch: async (next, request) => {
								fileRequests += 1
								return next(request)
							},
						},
					)
					expect(badFileRes.exitCode).toBe(1)
					expect(badFileRes.stdout).toBe("")
					expect(badFileRes.stderr).toContain("bad-utf8.txt")
					expect(badFileRes.stderr).toContain("not valid UTF-8")
					expect(fileRequests).toBe(0)

					let stdinRequests = 0
					const badJsonStdinBytes = new Uint8Array([
						...encoder.encode('{"name":"Bad'),
						0xff,
						...encoder.encode('Name","model":"gpt-6.2-sol"}'),
					])
					const badStdinRes = yield* cli.run(["agents", "create"], {
						stdin: Stream.make(badJsonStdinBytes),
						interceptFetch: async (next, request) => {
							stdinRequests += 1
							return next(request)
						},
					})
					expect(badStdinRes.exitCode).toBe(1)
					expect(badStdinRes.stdout).toBe("")
					expect(badStdinRes.stderr).toContain("stdin")
					expect(badStdinRes.stderr).toContain("not valid UTF-8")
					expect(stdinRequests).toBe(0)

					const utf8PromptBytes = encoder.encode("Be concise: café 🚀")
					const validFileRes = yield* cli.run(
						[
							"agents",
							"create",
							"--name",
							"ValidUtf8File",
							"--model",
							"gpt-6.2-sol",
							"--system",
							"@utf8.txt",
						],
						{
							files: {
								"utf8.txt": Stream.fromIterable([
									utf8PromptBytes.slice(0, 16),
									utf8PromptBytes.slice(16),
								]),
							},
						},
					)
					expect(validFileRes.exitCode).toBe(0)
					expect((JSON.parse(validFileRes.stdout) as { system: string }).system).toBe(
						"Be concise: café 🚀",
					)
				}),
			),
		)
	})

	it("reads an artifact upload from stdin up to the API's limit and keeps other commands at 2 MiB", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const cli = yield* makeTestServer()
					const megabyte = "x".repeat(MAX_INLINE_FILE_BYTES)
					const upload = JSON.stringify({
						name: "Two files",
						files: [
							{ path: "a.txt", content: megabyte },
							{ path: "b.txt", content: megabyte },
						],
					})
					expect(upload.length).toBeGreaterThan(MAX_INPUT_BYTES)
					const created = yield* cli.run(["artifacts", "create"], { stdin: upload })
					expect(created.stderr).toBe("")
					expect(created.exitCode).toBe(0)
					const artifact = JSON.parse(created.stdout) as { id: string; total_bytes: number }
					expect(artifact.total_bytes).toBe(2 * MAX_INLINE_FILE_BYTES)

					const added = yield* cli.run(
						["artifacts:versions", "create", "--artifact-id", artifact.id],
						{ stdin: JSON.stringify({ version: 1, files: JSON.parse(upload).files }) },
					)
					expect(added.exitCode).toBe(0)
					expect((JSON.parse(added.stdout) as { version: number }).version).toBe(2)
					expect(
						yield* untilListed(
							cli.run(["artifacts", "list", "--order", "desc", "--limit", "5"]),
							artifact.id,
						),
					).toEqual([artifact.id])

					let requests = 0
					const tooLarge = yield* cli.run(["agents", "create"], {
						stdin: JSON.stringify({
							name: "Big",
							model: "gpt-6.2-sol",
							system: "x".repeat(3 * 1024 * 1024),
						}),
						interceptFetch: async (next, request) => {
							requests += 1
							return next(request)
						},
					})
					expect(tooLarge.exitCode).toBe(1)
					expect(tooLarge.stdout).toBe("")
					expect(tooLarge.stderr).toContain(`stdin payload exceeds ${MAX_INPUT_BYTES} byte limit`)
					expect(requests).toBe(0)
				}),
			),
		)
	})

	it("reads one artifact file, an array of files, or a whole body from stdin", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const cli = yield* makeTestServer()
					type Artifact = {
						id: string
						name: string
						version: number
						files: Array<{ path: string }>
					}

					const single = yield* cli.run(["artifacts", "create", "--name", "Report"], {
						stdin: JSON.stringify({ path: "a.txt", content: "a" }),
					})
					expect(single.stderr).toBe("")
					expect(single.exitCode).toBe(0)
					const artifact = JSON.parse(single.stdout) as Artifact
					expect(artifact.name).toBe("Report")
					expect(artifact.files.map((file) => file.path)).toEqual(["a.txt"])

					const singleYaml = yield* cli.run(
						[
							"artifacts:versions",
							"create",
							"--artifact-id",
							artifact.id,
							"--current-version",
							"1",
						],
						{ stdin: "path: b.txt\ncontent: b\n" },
					)
					expect(singleYaml.exitCode).toBe(0)
					expect(
						(JSON.parse(singleYaml.stdout) as Artifact).files.map((file) => file.path),
					).toEqual(["b.txt"])

					const array = yield* cli.run(["artifacts", "create", "--name", "Pair"], {
						stdin: JSON.stringify([
							{ path: "a.txt", content: "a" },
							{ path: "b.txt", content: "b" },
						]),
					})
					expect(array.exitCode).toBe(0)
					expect((JSON.parse(array.stdout) as Artifact).files.map((file) => file.path)).toEqual([
						"a.txt",
						"b.txt",
					])

					const whole = yield* cli.run(["artifacts", "create"], {
						stdin: JSON.stringify({ name: "Whole", files: [{ path: "c.txt", content: "c" }] }),
					})
					expect(whole.exitCode).toBe(0)
					expect((JSON.parse(whole.stdout) as Artifact).name).toBe("Whole")

					const wholeVersion = yield* cli.run(
						["artifacts:versions", "create", "--artifact-id", artifact.id],
						{ stdin: JSON.stringify({ version: 2, files: [{ path: "d.txt", content: "d" }] }) },
					)
					expect(wholeVersion.exitCode).toBe(0)
					expect((JSON.parse(wholeVersion.stdout) as Artifact).version).toBe(3)

					let requests = 0
					const countRequests = async (
						next: (request: Request) => Promise<Response>,
						request: Request,
					) => {
						requests += 1
						return next(request)
					}
					const scalar = yield* cli.run(["artifacts", "create", "--name", "Scalar"], {
						stdin: "just text\n",
						interceptFetch: countRequests,
					})
					expect(scalar.exitCode).toBe(1)
					expect(scalar.stdout).toBe("")
					expect(scalar.stderr).toContain(
						"Expected stdin to be { files: [...] }, an array, or a single item object.",
					)

					const mixed = yield* cli.run(["artifacts", "create"], {
						stdin: JSON.stringify({ name: "Mixed", path: "a.txt", content: "a" }),
						interceptFetch: countRequests,
					})
					expect(mixed.exitCode).toBe(1)
					expect(mixed.stdout).toBe("")
					expect(mixed.stderr).toContain("Invalid artifacts create payload")

					const badItem = yield* cli.run(["artifacts", "create", "--name", "Bad"], {
						stdin: JSON.stringify({ type: "user.message", content: "a" }),
						interceptFetch: countRequests,
					})
					expect(badItem.exitCode).toBe(1)
					expect(badItem.stdout).toBe("")
					expect(badItem.stderr).toContain("Invalid artifacts create payload")
					expect(requests).toBe(0)
				}),
			),
		)
	})

	it("reads a --file @path up to the artifact input bound and keeps other commands at 2 MiB", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const cli = yield* makeTestServer()
					const record = JSON.stringify({
						path: "newlines.txt",
						content: "\n".repeat(MAX_INLINE_FILE_BYTES),
					})
					expect(record.length).toBeGreaterThan(MAX_INPUT_BYTES)

					const created = yield* cli.run(
						["artifacts", "create", "--name", "Newlines", "--file", "@big.json"],
						{ files: { "big.json": record } },
					)
					expect(created.stderr).toBe("")
					expect(created.exitCode).toBe(0)
					expect((JSON.parse(created.stdout) as { total_bytes: number }).total_bytes).toBe(
						MAX_INLINE_FILE_BYTES,
					)

					let requests = 0
					const event = JSON.stringify({
						type: "user.message",
						content: [{ type: "text", text: "x".repeat(3 * 1024 * 1024) }],
					})
					const tooLarge = yield* cli.run(
						["sessions:events", "send", "--session-id", "sess_1", "--event", "@big.json"],
						{
							files: { "big.json": event },
							interceptFetch: async (next, request) => {
								requests += 1
								return next(request)
							},
						},
					)
					expect(tooLarge.exitCode).toBe(1)
					expect(tooLarge.stdout).toBe("")
					expect(tooLarge.stderr).toContain(
						`File "big.json" exceeds ${MAX_INPUT_BYTES} byte limit.`,
					)
					expect(requests).toBe(0)
				}),
			),
		)
	})

	it("counts every --file @path of one request against a single artifact input budget", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const cli = yield* makeTestServer()
					const small = yield* cli.run(
						["artifacts", "create", "--name", "Pair", "--file", "@a.json", "--file", "@b.json"],
						{
							files: {
								"a.json": JSON.stringify({ path: "a.txt", content: "a" }),
								"b.json": JSON.stringify({ path: "b.txt", content: "b" }),
							},
						},
					)
					expect(small.stderr).toBe("")
					expect(small.exitCode).toBe(0)

					const half = JSON.stringify({
						path: "half.txt",
						content: "x".repeat(MAX_ARTIFACT_BODY_BYTES / 2),
					})
					expect(half.length).toBeLessThan(MAX_ARTIFACT_BODY_BYTES)
					let requests = 0
					const read: Array<string> = []
					const tooLarge = yield* cli.run(
						["artifacts", "create", "--name", "Big", "--file", "@a.json", "--file", "@b.json"],
						{
							files: { "a.json": half, "b.json": half },
							onRead: (filePath) => read.push(filePath),
							interceptFetch: async (next, request) => {
								requests += 1
								return next(request)
							},
						},
					)
					expect(tooLarge.exitCode).toBe(1)
					expect(tooLarge.stderr).toContain(
						`File "b.json" exceeds ${MAX_ARTIFACT_BODY_BYTES} byte limit`,
					)
					expect(read).toEqual(["a.json"])
					expect(requests).toBe(0)
				}),
			),
		)
	})

	it("refuses artifacts:versions file without --file before sending a request", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const cli = yield* makeTestServer()
					let requests = 0
					const missing = yield* cli.run(
						["artifacts:versions", "file", "--artifact-id", "art_1", "--current-version", "1"],
						{
							interceptFetch: async (next, request) => {
								requests += 1
								return next(request)
							},
						},
					)
					expect(missing.exitCode).toBe(1)
					expect(missing.stdout).toBe("")
					expect(missing.stderr).toContain("--file")
					expect(requests).toBe(0)
				}),
			),
		)
	})
})
