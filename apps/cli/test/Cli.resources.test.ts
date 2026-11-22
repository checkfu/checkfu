import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { TEST_API_KEY, makeTestServer } from "./helpers/CliHarness.ts"

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

					// TTY invalid invocation must not display literal escaped ANSI codes around ERROR,
					// while still escaping untrusted control characters from the argument itself
					const ttyInvalid = yield* cli.run(["agents", "bad\x1b]52;c;evil\x07cmd"], {
						stderrIsTerminal: true,
					})
					expect(ttyInvalid.exitCode).toBe(1)
					expect(ttyInvalid.stdout).toBe("")
					expect(ttyInvalid.stderr).toContain("ERROR")
					expect(ttyInvalid.stderr).not.toContain("\\x1b[1m")
					expect(ttyInvalid.stderr).not.toContain("\x1b")
					expect(ttyInvalid.stderr).not.toContain("\x07")

					// Explicitly blank --base-url must fail rather than falling back to CHECKFU_API_URL
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
				}),
			),
		)
	})

	it("manages full agent lifecycle via flags, @file, JSON/YAML stdin, and --transform", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const cli = yield* makeTestServer()

					// Create with flags + @file system prompt + --transform -r
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

					// Retrieve with global --format yaml placed before subcommand
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

					// Update with flags
					const updated = yield* cli.run([
						"agents",
						"update",
						"--agent-id",
						agentId,
						"--version",
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

					// Stale version fails with 409
					const conflict = yield* cli.run([
						"agents",
						"update",
						"--agent-id",
						agentId,
						"--version",
						"1",
						"--name",
						"Stale",
					])
					expect(conflict.exitCode).toBe(1)
					expect(conflict.stdout).toBe("")
					expect(conflict.stderr).toContain("409")

					// Archive
					const archived = yield* cli.run(["agents", "archive", "--agent-id", agentId])
					expect(archived.exitCode).toBe(0)
					expect(JSON.parse(archived.stdout).archived_at).not.toBeNull()

					// Create from YAML stdin with flag override
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
						"--version",
						"1",
						"--description",
						"Updated env",
					])
					expect(updated.exitCode).toBe(0)
					expect(JSON.parse(updated.stdout).description).toBe("Updated env")

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

					// Missing agent diagnosed specifically
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

					// Missing environment diagnosed specifically
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

					// Create session with object --agent and --title
					const created = yield* cli.run(
						[
							"sessions",
							"create",
							"--agent",
							`{"id":"${agentId}","version":1}`,
							"--environment-id",
							envId,
							"--title",
							"CLI Session",
						],
						{
							env: { CHECKFU_API_KEY: TEST_API_KEY, CHECKFU_URL: "http://localhost:1337" },
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
					expect(session.agent).toEqual({ id: agentId, version: 1 })
					expect(session.environment_id).toBe(envId)
					expect(session.title).toBe("CLI Session")
					expect(session.status).toBe("idle")

					const retrieved = yield* cli.run(["sessions", "retrieve", "--session-id", session.id])
					expect(retrieved.exitCode).toBe(0)
					expect(JSON.parse(retrieved.stdout).id).toBe(session.id)

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

					// Single-line YAML mappings with quoted keys work for --model, --agent, and @file
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
						`"id": ${agent.id}`,
						"--environment-id",
						envId,
					])
					expect(quotedAgentSession.exitCode).toBe(0)
					expect(
						(JSON.parse(quotedAgentSession.stdout) as { agent: { id: string } }).agent.id,
					).toBe(agent.id)

					const quotedAgentFileSession = yield* cli.run(
						["sessions", "create", "--agent", "@agent.yaml", "--environment-id", envId],
						{ files: { "agent.yaml": `"id": ${agent.id}\n` } },
					)
					expect(quotedAgentFileSession.exitCode).toBe(0)
					expect(
						(JSON.parse(quotedAgentFileSession.stdout) as { agent: { id: string } }).agent.id,
					).toBe(agent.id)

					// Misspelled top-level or nested keys in request bodies are rejected instead of dropped
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
				}),
			),
		)
	})
})
