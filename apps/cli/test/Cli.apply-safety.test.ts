import {
	CONFLICT_EXIT_CODE,
	NOT_FOUND_EXIT_CODE,
	RETRY_EXIT_CODE,
	USAGE_EXIT_CODE,
} from "../src/Errors.ts"
import { IsSupportedAgentModel } from "@checkfu/api/Http/AgentsHandlers"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import { formatProjectLockfile, ProjectLockfile } from "@checkfu/authoring/lockfile"
import type { Automation } from "@checkfu/sdk/Api"
import { hashOf } from "../src/Project/Plan.ts"
import { makeTestServer } from "./helpers/CliHarness.ts"
import type { CliRunOptions, CliRunResult } from "./helpers/CliHarness.ts"

const model = "fixture-model"
const cloud = "environments/cloud.yaml"
const reporter = "agents/reporter.yaml"
const report = "automations/report.yaml"

const agentSource = (name: string) => `name: ${name}\nmodel: ${model}\n`
const reportSource = (
	name: string,
	agent = "../agents/reporter.yaml",
	environment = "../environments/cloud.yaml",
) =>
	[
		"name: " + name,
		"agent: " + agent,
		"environment_id: " + environment,
		"initial_events: [{type: user.message, content: [{type: text, text: Write the report.}]}]",
		"schedule: {type: cron, expression: '0 9 * * *', timezone: UTC}",
		"",
	].join("\n")

interface Row {
	readonly file: string
	readonly action: string
	readonly id?: string
}

const rows = (result: CliRunResult) => {
	expect(result.stderr).toBe("")
	expect(result.exitCode).toBe(0)
	return JSON.parse(result.stdout) as ReadonlyArray<Row>
}

const idOf = (list: ReadonlyArray<Row>, file: string) => {
	const id = list.find((row) => row.file === `./${file}`)?.id
	if (id === undefined) {
		throw new Error(`No resource ID for ${file}.`)
	}
	return id
}

const fixture = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const root = yield* fs.makeTempDirectoryScoped()
	const file = (relative: string) => path.join(root, relative)
	const lockfile = file("checkfu-lock.json")
	const write = (relative: string, contents: string) =>
		fs
			.makeDirectory(path.dirname(file(relative)), { recursive: true })
			.pipe(Effect.andThen(fs.writeFileString(file(relative), contents)))
	const readLock = fs
		.readFileString(lockfile)
		.pipe(Effect.flatMap(Schema.decodeEffect(ProjectLockfile)))
	let modelAvailable = true
	const cli = yield* makeTestServer().pipe(
		Effect.provideService(IsSupportedAgentModel, (id) => modelAvailable && id === model),
	)
	const run = (args: ReadonlyArray<string>, options?: CliRunOptions) =>
		cli.run(args, { ...options, fileSystem: NodeFileSystem.layer })
	const apply = (
		paths: ReadonlyArray<string>,
		flags: ReadonlyArray<string> = ["--yes"],
		options?: CliRunOptions,
	) => run(["apply", "--lock-file", lockfile, ...flags, ...paths.map(file)], options)

	return {
		fs,
		file,
		write,
		readLock,
		run,
		apply,
		retireModel: () => {
			modelAvailable = false
		},
	}
})

type Fixture = Effect.Success<typeof fixture>
const testProject = <E, R>(body: (fixture: Fixture) => Effect.Effect<void, E, R>) =>
	Effect.scoped(
		fixture.pipe(
			Effect.flatMap(body),
			Effect.provide(Layer.merge(NodeFileSystem.layer, Path.layer)),
		),
	)

const standardProject = ({ write }: Fixture) =>
	Effect.gen(function* () {
		yield* write(cloud, "name: Cloud\n")
		yield* write(reporter, agentSource("Reporter"))
		yield* write(report, reportSource("Morning report"))
	})

it.each([
	{ choice: "Cancel", exitCode: 0, message: "Cancelled. Nothing was applied." },
	{
		choice: "end of input",
		exitCode: USAGE_EXIT_CODE,
		message:
			"The confirmation prompt was interrupted. Nothing was applied. Use --yes to apply without a prompt.",
	},
])(
	"reports $choice at the apply confirmation without making writes",
	({ choice, exitCode, message }) =>
		Effect.runPromise(
			testProject(({ apply, file, fs, write }) =>
				Effect.gen(function* () {
					yield* write(reporter, agentSource("Reporter"))
					const writes: Array<string> = []
					const result = yield* apply([reporter], [], {
						stdinIsTerminal: true,
						stdoutIsTerminal: true,
						terminalInputs:
							choice === "Cancel"
								? [
										{
											input: Option.none(),
											key: { name: "return", ctrl: false, meta: false, shift: false },
										},
									]
								: [],
						interceptFetch: (next, request) => {
							if (request.method !== "GET") {
								writes.push(request.method)
							}
							return next(request)
						},
					})
					expect(result.exitCode).toBe(exitCode)
					expect(result.stderr).toContain(message)
					expect(writes).toEqual([])
					expect(yield* fs.exists(file("checkfu-lock.json"))).toBe(false)
				}),
			),
		),
)

it("prunes only tracked files under the selected directory or explicitly named", () =>
	Effect.runPromise(
		testProject((project) =>
			Effect.gen(function* () {
				const { apply, write, fs, file, run, readLock } = project
				yield* standardProject(project)
				const spare = "agents/spare.yaml"
				yield* write(spare, agentSource("Spare"))
				const created = rows(yield* apply(["."]))
				yield* fs.remove(file(spare))
				yield* fs.remove(file(cloud))
				yield* fs.remove(file("automations"), { recursive: true })

				expect(rows(yield* apply(["agents"], ["--yes", "--prune"]))).toEqual([
					{ file: `./${reporter}`, action: "unchanged", id: idOf(created, reporter) },
					{ file: `./${spare}`, action: "archive", id: idOf(created, spare) },
				])
				const untouched = yield* run([
					"automations",
					"retrieve",
					"--automation-id",
					idOf(created, report),
				])
				expect(JSON.parse(untouched.stdout)).toMatchObject({ status: "active" })
				expect(yield* readLock).toMatchObject({
					resources: {
						[`./${cloud}`]: { id: idOf(created, cloud) },
						[`./${report}`]: { id: idOf(created, report) },
					},
				})
				expect(rows(yield* apply(["automations"], ["--yes", "--prune"]))).toEqual([
					{ file: `./${report}`, action: "archive", id: idOf(created, report) },
				])
				expect(rows(yield* apply([], ["--dry-run", "--prune"]))).toContainEqual({
					file: `./${cloud}`,
					action: "archive",
					id: idOf(created, cloud),
				})
			}),
		),
	))

it("uses tracked kinds on pathless and directory applies and validates authored references", () =>
	Effect.runPromise(
		testProject(({ apply, write }) =>
			Effect.gen(function* () {
				yield* write("a.yaml", agentSource("Reporter"))
				yield* write(cloud, "name: Cloud\n")
				yield* write(report, reportSource("Report", "../a.yaml"))
				const fromAgent = rows(yield* apply(["a.yaml", report], ["--dry-run"]))
				const fromAutomation = rows(yield* apply([report, "a.yaml"], ["--dry-run"]))
				expect(fromAgent).toEqual(fromAutomation)
				expect(fromAgent.map(({ file }) => file)).toContain("./a.yaml")
				const created = rows(yield* apply([report]))
				expect(rows(yield* apply([])).map((row) => row.action)).toEqual([
					"unchanged",
					"unchanged",
					"unchanged",
				])
				expect(rows(yield* apply(["."], ["--dry-run"]))).toContainEqual({
					file: "./a.yaml",
					action: "unchanged",
					id: idOf(created, "a.yaml"),
				})

				yield* write(report, reportSource("Report", "{path: ../a.yaml, id: agent_other}"))
				const ambiguous = yield* apply([report], ["--dry-run"])
				expect(ambiguous.exitCode).toBe(USAGE_EXIT_CODE)
				expect(ambiguous.stderr).toContain("agent")

				yield* write(report, reportSource("Report", "../a.yaml"))
				yield* write("a.yaml", "name: [broken")
				const malformed = yield* apply(["."], ["--dry-run"])
				expect(malformed.exitCode).toBe(USAGE_EXIT_CODE)
				expect(malformed.stderr).toContain("./a.yaml")
			}),
		),
	))

it("accepts a project-root alias while preserving the physical project's lock and resource identities", () =>
	Effect.runPromise(
		testProject(({ fs, file, write, run }) =>
			Effect.gen(function* () {
				const path = yield* Path.Path
				yield* write(reporter, agentSource("Aliased root"))
				const physical = yield* fs.realPath(file("."))
				const directory = yield* fs.makeTempDirectoryScoped()
				const alias = path.join(directory, "project")
				yield* fs.symlink(physical, alias)
				const lock = path.join(physical, "checkfu-lock.json")
				const result = yield* run([
					"apply",
					"--lock-file",
					lock,
					"--yes",
					path.join(alias, reporter),
				])
				expect(rows(result)).toMatchObject([{ file: `./${reporter}`, action: "create" }])
				const repeated = yield* run([
					"apply",
					"--lock-file",
					lock,
					"--dry-run",
					path.join(physical, reporter),
				])
				expect(rows(repeated)).toMatchObject([{ file: `./${reporter}`, action: "unchanged" }])
			}),
		),
	))

const lockHash = "0".repeat(64)
const lockedReporter = { kind: "agent", id: "agent_reporter", hash: lockHash } as const

it.each([
	{
		path: "./agents//reporter.yaml",
		entries: { resources: { "./agents//reporter.yaml": lockedReporter } },
	},
	{
		path: "./agents/reporter.yaml/",
		entries: {
			resources: {
				[`./${reporter}`]: lockedReporter,
				"./agents/reporter.yaml/": { ...lockedReporter, id: "agent_other" },
			},
		},
	},
	{
		path: ".//agents/reporter.yaml",
		entries: {
			pending_creates: {
				".//agents/reporter.yaml": { kind: "agent", key: "cli_original", hash: lockHash },
			},
		},
	},
	{
		path: "./environments//cloud.yaml",
		entries: {
			pending_creates: {
				[`./${report}`]: {
					kind: "automation",
					key: "cli_original",
					hash: lockHash,
					dependencies: {
						agent: { id: "agent_reporter", version: 1, path: `./${reporter}` },
						environment_id: { id: "env_cloud", path: "./environments//cloud.yaml" },
					},
				},
			},
		},
	},
] satisfies ReadonlyArray<{ path: string; entries: Partial<ProjectLockfile> }>)(
	"refuses the noncanonical lock path $path before accessing the API",
	({ path, entries }) =>
		Effect.runPromise(
			testProject((project) =>
				Effect.gen(function* () {
					const { apply, file, fs, write } = project
					yield* standardProject(project)
					const lockfile = "checkfu-lock.json"
					const contents = formatProjectLockfile({
						version: 1,
						base_url: "http://localhost:1337",
						resources: {},
						...entries,
					})
					yield* write(lockfile, contents)
					const requests: Array<string> = []
					for (const flag of ["--dry-run", "--yes"]) {
						const result = yield* apply(["."], [flag], {
							interceptFetch: (next, request) => {
								requests.push(request.method)
								return next(request)
							},
						})
						expect(result.exitCode).toBe(USAGE_EXIT_CODE)
						expect(result.stderr).toContain("invalid lockfile")
						expect(result.stderr).toContain(path)
						expect(requests).toEqual([])
						expect(yield* fs.readFileString(file(lockfile))).toBe(contents)
					}
				}),
			),
		),
)

it("validates all settled lock owner kinds before planning, including prune and force", () =>
	Effect.runPromise(
		testProject((project) =>
			Effect.gen(function* () {
				const { apply, file, fs, write } = project
				yield* standardProject(project)
				const kinds = ["agent", "environment", "automation"] as const
				const ids = ["agent_good-1", "env_good-1", "auto_good-1"] as const
				const key = `./${reporter}`
				const lockfile = "checkfu-lock.json"
				for (const [expected, kind] of kinds.entries()) {
					for (const [actual, id] of ids.entries()) {
						const contents = JSON.stringify({
							version: 1,
							base_url: "http://localhost:1337",
							resources: { [key]: { kind, id, hash: lockHash } },
						})
						if (actual === expected) {
							const lock = yield* Schema.decodeEffect(ProjectLockfile)(contents)
							expect(lock.resources[key]).toMatchObject({
								kind,
								id,
							})
							continue
						}
						for (const flags of [
							["--dry-run", "--force"],
							["--yes", "--prune"],
						]) {
							yield* write(lockfile, contents)
							const requests: Array<string> = []
							const result = yield* apply(["."], flags, {
								interceptFetch: (next, request) => {
									requests.push(request.method)
									return next(request)
								},
							})
							expect(result.exitCode).toBe(USAGE_EXIT_CODE)
							expect(result.stderr).toContain("invalid lockfile")
							expect(result.stderr).toContain(key)
							expect(result.stderr).toContain(id)
							expect(requests).toEqual([])
							expect(yield* fs.readFileString(file(lockfile))).toBe(contents)
						}
					}
				}
			}),
		),
	))

it("rejects explicit inputs and references beneath a symlinked directory", () =>
	Effect.runPromise(
		testProject(({ fs, file, write, apply }) =>
			Effect.gen(function* () {
				const outside = yield* fs.makeTempDirectoryScoped()
				const path = yield* Path.Path
				yield* fs.writeFileString(path.join(outside, "agent.yaml"), agentSource("Outside"))
				yield* fs.symlink(outside, file("linked"))
				const explicit = yield* apply(["linked/agent.yaml"], ["--dry-run"])
				expect(explicit.exitCode).toBe(USAGE_EXIT_CODE)
				expect(explicit.stderr).toContain("symbolic link")
				yield* write(cloud, "name: Cloud\n")
				yield* write(report, reportSource("Report", "../linked/agent.yaml"))
				const reference = yield* apply([report], ["--dry-run"])
				expect(reference.exitCode).toBe(USAGE_EXIT_CODE)
				expect(reference.stderr).toContain("symbolic link")
				expect(yield* fs.exists(file("checkfu-lock.json"))).toBe(false)
			}),
		),
	))

it("clears a definitive create rejection so an archived reference can be corrected", () =>
	Effect.runPromise(
		testProject((project) =>
			Effect.gen(function* () {
				const { apply, write, run, readLock } = project
				yield* standardProject(project)
				const created = rows(yield* apply([reporter, cloud]))
				const archivedId = idOf(created, reporter)
				expect((yield* run(["agents", "archive", "--agent-id", archivedId])).exitCode).toBe(0)
				yield* write(report, reportSource("Report", archivedId, idOf(created, cloud)))
				const refused = yield* apply([report])
				expect(refused.exitCode).toBe(CONFLICT_EXIT_CODE)
				expect(refused.stderr).toContain("archived")
				expect(yield* readLock).not.toHaveProperty("pending_creates")

				const spare = "agents/spare.yaml"
				yield* write(spare, agentSource("Replacement"))
				const fixed = rows(yield* apply([spare]))
				yield* write(report, reportSource("Report", idOf(fixed, spare), idOf(created, cloud)))
				expect(rows(yield* apply([report]))[0]?.action).toBe("create")
			}),
		),
	))

it("sends an automation patch with a revision and preserves a concurrent schedule edit", () =>
	Effect.runPromise(
		testProject((project) =>
			Effect.gen(function* () {
				const { apply, run, write } = project
				yield* standardProject(project)
				const id = idOf(rows(yield* apply([report])), report)
				yield* write(report, reportSource("New name"))
				let sent: unknown
				const attempted = yield* apply([report], ["--yes"], {
					interceptFetch: async (next, request) => {
						if (
							request.method === "POST" &&
							new URL(request.url).pathname === `/v1/automations/${id}`
						) {
							sent = await request.clone().json()
							const headers = new Headers(request.headers)
							headers.delete("content-length")
							headers.set("content-type", "application/json")
							const result = await next(
								new Request(request.url, {
									method: "POST",
									headers,
									body: JSON.stringify({ schedule: { expression: "0 10 * * *" } }),
								}),
							)
							expect(result.status).toBe(200)
						}
						return next(request)
					},
				})
				expect(sent).toEqual({ name: "New name", revision: 1 })
				expect(attempted.exitCode).toBe(CONFLICT_EXIT_CODE)
				expect(attempted.stderr).toContain("automation changed")
				const current = yield* run(["automations", "retrieve", "--automation-id", id])
				expect(JSON.parse(current.stdout)).toMatchObject({
					name: "Morning report",
					schedule: { expression: "0 10 * * *" },
				})
			}),
		),
	))

it("uses the literal agent version reviewed during each apply", () =>
	Effect.runPromise(
		testProject((project) =>
			Effect.gen(function* () {
				const { apply, readLock, run, write } = project
				yield* standardProject(project)
				const dependencies = rows(yield* apply([reporter, cloud]))
				const agentId = idOf(dependencies, reporter)
				const environmentId = idOf(dependencies, cloud)
				yield* write(report, reportSource("Report", agentId, environmentId))
				const id = idOf(rows(yield* apply([report])), report)
				const before = yield* readLock
				const expectedAgent = (version: number) => ({ id: agentId, version })
				const remote = () =>
					run(["automations", "retrieve", "--automation-id", id]).pipe(
						Effect.map((result) => JSON.parse(result.stdout) as Automation),
					)
				const writes: Array<unknown> = []
				let agentReads = 0
				const moveHead = (version: number): CliRunOptions => ({
					interceptFetch: async (next, request) => {
						if (request.method === "POST") {
							writes.push(await request.clone().json())
						}
						const response = await next(request)
						if (
							request.method === "GET" &&
							new URL(request.url).pathname === `/v1/agents/${agentId}`
						) {
							agentReads += 1
							if (agentReads === 1) {
								const headers = new Headers(request.headers)
								headers.set("content-type", "application/json")
								const updated = await next(
									new Request(request.url, {
										method: "POST",
										headers,
										body: JSON.stringify({ version, name: `Agent head ${version + 1}` }),
									}),
								)
								expect(updated.status).toBe(200)
							}
						}
						return response
					},
				})

				const unchanged = yield* apply([report], [], moveHead(1))
				expect(writes).toEqual([])
				expect(agentReads).toBe(1)
				expect(rows(unchanged)).toEqual([{ action: "unchanged", file: `./${report}`, id }])
				expect(yield* readLock).toEqual(before)
				expect((yield* remote()).agent).toEqual(expectedAgent(1))

				const approval = yield* apply([report], [])
				expect(approval.exitCode).toBe(USAGE_EXIT_CODE)
				expect(approval.stderr).toContain("--yes")
				expect(JSON.parse(approval.stdout)).toMatchObject([{ action: "update", fields: ["agent"] }])
				yield* write(report, reportSource("Updated report", agentId, environmentId))
				agentReads = 0
				const update = yield* apply([report], ["--yes"], moveHead(2))
				expect(rows(update)).toMatchObject([{ action: "update", fields: ["name", "agent"] }])
				expect(writes).toEqual([
					{ name: "Updated report", agent: { type: "agent", ...expectedAgent(2) }, revision: 1 },
				])
				expect(agentReads).toBe(1)
				const confirmed = yield* remote()
				expect(confirmed.agent).toEqual(expectedAgent(2))
				expect((yield* readLock).resources[`./${report}`]?.hash).toBe(hashOf(confirmed))

				expect(rows(yield* apply([report]))).toMatchObject([
					{ action: "update", fields: ["agent"] },
				])
				expect((yield* remote()).agent).toEqual(expectedAgent(3))
				yield* write(
					report,
					reportSource(
						"Updated report",
						`{type: agent, id: ${agentId}, version: 1}`,
						environmentId,
					),
				)
				expect(rows(yield* apply([report])).at(0)?.action).toBe("update")
				expect((yield* remote()).agent).toEqual(expectedAgent(1))
			}),
		),
	))

it("pins a literal agent before applying an environment referenced by path", () =>
	Effect.runPromise(
		testProject(({ apply, write }) =>
			Effect.gen(function* () {
				yield* write(reporter, agentSource("Reporter"))
				const agentId = idOf(rows(yield* apply([reporter])), reporter)
				yield* write(cloud, "name: Cloud\n")
				yield* write(report, reportSource("Report", agentId))
				expect(rows(yield* apply([report], ["--dry-run"])).at(-1)).toMatchObject({
					action: "create",
					configuration: {
						agent: { type: "agent", id: agentId, version: 1 },
						environment_id: "../environments/cloud.yaml",
					},
				})
				let sent: unknown
				const applied = rows(
					yield* apply([report], ["--yes"], {
						interceptFetch: async (next, request) => {
							const path = new URL(request.url).pathname
							if (request.method === "POST" && path === "/v1/environments") {
								const headers = new Headers(request.headers)
								headers.delete("content-length")
								headers.delete("idempotency-key")
								headers.set("content-type", "application/json")
								const advanced = await next(
									new Request(new URL(`/v1/agents/${agentId}`, request.url), {
										method: "POST",
										headers,
										body: JSON.stringify({ version: 1, name: "Changed during apply" }),
									}),
								)
								expect(advanced.status).toBe(200)
							}
							if (request.method === "POST" && path === "/v1/automations") {
								sent = await request.clone().json()
							}
							return next(request)
						},
					}),
				)
				expect(applied.map(({ action }) => action)).toEqual(["create", "create"])
				expect(sent).toMatchObject({
					agent: { type: "agent", id: agentId, version: 1 },
					environment_id: idOf(applied, cloud),
				})
			}),
		),
	))

it("reports default networking drift and patches an agent without resending a retired model", () =>
	Effect.runPromise(
		testProject((project) =>
			Effect.gen(function* () {
				const { apply, run, write, retireModel } = project
				yield* standardProject(project)
				const created = rows(yield* apply([reporter, cloud]))
				const envId = idOf(created, cloud)
				const config = {
					type: "cloud",
					networking: {
						type: "limited",
						allow_mcp_servers: false,
						allow_package_managers: false,
						allowed_hosts: [],
					},
				}
				const changed = yield* run([
					"environments",
					"update",
					"--environment-id",
					envId,
					"--current-version",
					"1",
					"--config",
					JSON.stringify(config),
				])
				expect(changed.exitCode).toBe(0)
				expect(rows(yield* apply([cloud], ["--dry-run"]))[0]).toMatchObject({
					action: "blocked",
					changes: { config: { from: config, to: { networking: { type: "unrestricted" } } } },
				})
				expect(rows(yield* apply([cloud], ["--yes", "--force"]))[0]?.action).toBe("update")

				yield* Effect.sync(retireModel)
				yield* write(reporter, agentSource("Renamed"))
				expect(rows(yield* apply([reporter]))[0]).toMatchObject({
					action: "update",
					id: idOf(created, reporter),
					fields: ["name"],
				})
			}),
		),
	))

const atAutomationCapacity = () =>
	Response.json(
		{
			type: "error",
			error: {
				type: "rate_limit_error",
				code: "automation_capacity_reached",
				message: "At capacity.",
			},
			request_id: "req_test",
		},
		{ status: 429 },
	)

it("releases capacity from an approved archive and retries creation with the same key", () =>
	Effect.runPromise(
		testProject((project) =>
			Effect.gen(function* () {
				const { apply, write, fs, file } = project
				yield* standardProject(project)
				const oldId = idOf(rows(yield* apply([report])), report)
				yield* fs.remove(file(report))
				const replacement = "automations/replacement.yaml"
				yield* write(replacement, reportSource("Replacement"))
				const writes: Array<string> = []
				const keys: Array<string | null> = []
				const applied = yield* apply(["automations"], ["--yes", "--prune"], {
					interceptFetch: async (next, request) => {
						const endpoint = new URL(request.url).pathname
						if (request.method === "POST") {
							writes.push(endpoint)
							if (endpoint === "/v1/automations") {
								keys.push(request.headers.get("Idempotency-Key"))
								if (keys.length < 3) {
									return atAutomationCapacity()
								}
							}
						}
						return next(request)
					},
				})
				expect(rows(applied).slice(-2)).toEqual([
					expect.objectContaining({ file: `./${replacement}`, action: "create" }),
					{ file: `./${report}`, action: "archive", id: oldId },
				])
				expect(writes).toEqual([
					"/v1/automations",
					`/v1/automations/${oldId}/archive`,
					"/v1/automations",
					"/v1/automations",
				])
				expect(keys).toHaveLength(3)
				expect(new Set(keys).size).toBe(1)
			}),
		),
	))

it("keeps an automation active when capacity is full and another create receipt is pending", () =>
	Effect.runPromise(
		testProject((project) =>
			Effect.gen(function* () {
				const { apply, write, fs, file, readLock, run } = project
				const copied = "automations/z-copy.yaml"
				yield* standardProject(project)
				rows(yield* apply([reporter, cloud]))
				const lost = yield* apply([report], ["--yes"], {
					interceptFetch: async (next, request) => {
						const response = await next(request)
						if (request.method === "POST" && new URL(request.url).pathname === "/v1/automations") {
							expect(response.status).toBe(201)
							throw new Error("Lost create response")
						}
						return response
					},
				})
				expect(lost.exitCode).toBe(RETRY_EXIT_CODE)
				const pending = (yield* readLock).pending_creates?.[`./${report}`]
				if (pending?.kind !== "automation") {
					throw new Error("The lock did not retain the pending automation create")
				}
				const id = idOf(rows(yield* apply([report])), report)
				const settled = yield* readLock
				yield* fs.rename(file(report), file(copied))
				yield* write("automations/a-new.yaml", reportSource("New report"))
				const lock = formatProjectLockfile({
					...settled,
					pending_creates: { [`./${copied}`]: pending },
				})
				yield* fs.writeFileString(file("checkfu-lock.json"), lock)
				const posts: Array<string> = []
				const applied = yield* apply(["automations"], ["--yes", "--prune"], {
					interceptFetch: (next, request) => {
						if (request.method !== "POST") {
							return next(request)
						}
						const endpoint = new URL(request.url).pathname
						posts.push(endpoint)
						return endpoint === "/v1/automations"
							? Promise.resolve(atAutomationCapacity())
							: next(request)
					},
				})
				expect(applied.exitCode).toBe(USAGE_EXIT_CODE)
				expect(applied.stderr).toContain(`Confirm the pending create for ./${copied}`)
				expect(posts).toEqual(["/v1/automations"])
				expect(yield* fs.readFileString(file("checkfu-lock.json"))).toBe(lock)
				const live = yield* run(["automations", "retrieve", "--automation-id", id])
				expect(JSON.parse(live.stdout)).toMatchObject({ id, archived_at: null })
			}),
		),
	))

it("keeps idempotency conflicts pending and records a successful create receipt despite later drift", () =>
	Effect.runPromise(
		testProject(({ apply, write, readLock }) =>
			Effect.gen(function* () {
				yield* write(reporter, agentSource("Reporter"))
				const conflict = yield* apply([reporter], ["--yes"], {
					interceptFetch: async () =>
						Response.json(
							{
								type: "error",
								error: {
									type: "conflict_error",
									code: "idempotency_key_reused",
									message: "The key has a conflicting request.",
								},
								request_id: "req_test",
							},
							{ status: 409 },
						),
				})
				expect(conflict.exitCode).toBe(CONFLICT_EXIT_CODE)
				expect(yield* readLock).toMatchObject({
					pending_creates: { [`./${reporter}`]: { kind: "agent" } },
				})

				const moved = yield* apply([reporter], ["--yes"], {
					interceptFetch: async (next, request) => {
						const response = await next(request)
						const body = (await response.json()) as { id: string; name: string }
						return Response.json({ ...body, name: "Another writer" }, { status: response.status })
					},
				})
				expect(moved.exitCode).toBe(USAGE_EXIT_CODE)
				expect(moved.stderr).toContain("differs from the confirmed create")
				const saved = yield* readLock
				expect(saved).not.toHaveProperty("pending_creates")
				expect(saved).toMatchObject({
					resources: { [`./${reporter}`]: { id: expect.stringMatching(/^agent_/) } },
				})
				expect(rows(yield* apply([reporter], ["--dry-run"]))[0]?.action).toBe("unchanged")
			}),
		),
	))

it.each([
	{ source: reporter, group: "agents", guard: { version: 1 }, patch: { version: 1 } },
	{ source: cloud, group: "environments", guard: { version: 1 }, patch: { version: 1 } },
	{ source: report, group: "automations", guard: { revision: 1 }, patch: { revision: 1 } },
])(
	"rejects an archive when $group change after the final read",
	({ source, group, guard, patch }) =>
		Effect.runPromise(
			testProject((project) =>
				Effect.gen(function* () {
					const { apply, fs, file, readLock } = project
					yield* standardProject(project)
					const id = idOf(rows(yield* apply([source])), source)
					const endpoint = `/v1/${group}/${id}`
					yield* fs.remove(file(source))
					const result = yield* apply([source], ["--yes", "--prune", "--force"], {
						interceptFetch: async (next, request) => {
							if (new URL(request.url).pathname !== `${endpoint}/archive`) {
								return next(request)
							}
							expect(Object.fromEntries(new URL(request.url).searchParams)).toEqual(
								Object.fromEntries(
									Object.entries(guard).map(([key, value]) => [key, String(value)]),
								),
							)
							const headers = new Headers(request.headers)
							headers.delete("content-length")
							headers.set("content-type", "application/json")
							const edited = await next(
								new Request(new URL(endpoint, request.url), {
									method: "POST",
									headers,
									body: JSON.stringify({ ...patch, name: "Concurrent edit" }),
								}),
							)
							expect(edited.status).toBe(200)
							const archived = await next(request)
							expect(archived.status).toBe(409)
							const live = await next(new Request(new URL(endpoint, request.url), { headers }))
							expect(await live.json()).toMatchObject({
								name: "Concurrent edit",
								archived_at: null,
							})
							return archived
						},
					})
					expect(result.exitCode).toBe(CONFLICT_EXIT_CODE)
					expect(yield* readLock).toMatchObject({ resources: { [`./${source}`]: { id } } })
				}),
			),
		),
)

it("blocks pruning IDs used by retained automations, including outside a selected scope", () =>
	Effect.runPromise(
		testProject((project) =>
			Effect.gen(function* () {
				const { apply, write, fs, file } = project
				yield* standardProject(project)
				const dependencies = rows(yield* apply([reporter, cloud]))
				yield* write(
					report,
					reportSource(
						"By ID",
						`{type: agent, id: ${idOf(dependencies, reporter)}, version: 1}`,
						idOf(dependencies, cloud),
					),
				)
				const automation = rows(yield* apply([report]))
				yield* fs.remove(file(reporter))
				yield* fs.remove(file(cloud))
				const full = rows(yield* apply([], ["--dry-run", "--prune"]))
				expect(full.filter(({ action }) => action === "blocked").map(({ file }) => file)).toEqual([
					`./${reporter}`,
					`./${cloud}`,
				])
				const scoped = yield* apply(["agents"], ["--yes", "--force", "--prune"], {
					interceptFetch: (next, request) => {
						expect(request.method).toBe("GET")
						return next(request)
					},
				})
				expect(scoped.exitCode).toBe(USAGE_EXIT_CODE)
				expect(scoped.stderr).toContain(`./${reporter}: Automation dependencies in ./${report}`)
				yield* fs.remove(file(report))
				expect(rows(yield* apply([], ["--yes", "--prune"]))[0]).toEqual({
					file: `./${report}`,
					action: "archive",
					id: idOf(automation, report),
				})
			}),
		),
	))

it.each([
	{
		source: reporter,
		group: "agents",
		removalMethod: "POST",
		removalSuffix: "/archive",
		replayExitCode: USAGE_EXIT_CODE,
	},
	{
		source: cloud,
		group: "environments",
		removalMethod: "DELETE",
		removalSuffix: "",
		replayExitCode: NOT_FOUND_EXIT_CODE,
	},
])(
	"checks the live $group after a lost create response",
	({ source, group, removalMethod, removalSuffix, replayExitCode }) =>
		Effect.runPromise(
			testProject((project) =>
				Effect.gen(function* () {
					const { apply, readLock } = project
					yield* standardProject(project)
					let id: string | undefined
					const interrupted = yield* apply([source], ["--yes"], {
						interceptFetch: async (next, request) => {
							const created = await next(request)
							expect(created.status).toBe(201)
							id = ((await created.json()) as { id: string }).id
							const removed = await next(
								new Request(new URL(`/v1/${group}/${id}${removalSuffix}`, request.url), {
									method: removalMethod,
									headers: { authorization: request.headers.get("authorization") ?? "" },
								}),
							)
							expect(removed.ok).toBe(true)
							throw new Error("Connection lost after commit.")
						},
					})
					expect(id).toBeDefined()
					expect(interrupted.exitCode).toBe(RETRY_EXIT_CODE)
					expect(yield* readLock).toHaveProperty("pending_creates")

					const methods: Array<string> = []
					const replayed = yield* apply([source], ["--yes"], {
						interceptFetch: async (next, request) => {
							methods.push(request.method)
							const response = await next(request)
							if (request.method === "POST") {
								expect(response.status).toBe(201)
							}
							return response
						},
					})
					expect(methods).toEqual(["POST", "GET"])
					expect(replayed.exitCode).toBe(replayExitCode)
					const saved = yield* readLock
					expect(saved).not.toHaveProperty("pending_creates")
					expect(saved).toMatchObject({ resources: { [`./${source}`]: { id } } })
				}),
			),
		),
)

it("replays the saved automation references before reconciling a newer agent version", () =>
	Effect.runPromise(
		testProject((project) =>
			Effect.gen(function* () {
				const { apply, write, readLock, run } = project
				yield* standardProject(project)
				const dependencies = rows(yield* apply([reporter, cloud]))
				const agent = idOf(dependencies, reporter)
				const environment = idOf(dependencies, cloud)
				let id: string | undefined
				let originalKey: string | null = null
				let originalBody: unknown
				const interrupted = yield* apply([report], ["--yes"], {
					interceptFetch: async (next, request) => {
						if (request.method !== "POST") {
							return next(request)
						}
						originalKey = request.headers.get("idempotency-key")
						originalBody = await request.clone().json()
						const created = await next(request)
						expect(created.status).toBe(201)
						id = ((await created.json()) as { id: string }).id
						throw new Error("Connection lost after commit.")
					},
				})
				expect(id).toBeDefined()
				expect(interrupted.exitCode).toBe(RETRY_EXIT_CODE)
				expect(yield* readLock).toMatchObject({
					pending_creates: {
						[`./${report}`]: {
							dependencies: {
								agent: { id: agent, version: 1, path: `./${reporter}` },
								environment_id: { id: environment, path: `./${cloud}` },
							},
						},
					},
				})
				yield* write(reporter, agentSource("New agent version"))
				expect(rows(yield* apply([reporter]))[0]?.action).toBe("update")
				expect(rows(yield* apply([report], ["--dry-run"])).at(-1)).toMatchObject({
					action: "create",
					configuration: { agent: "../agents/reporter.yaml" },
				})
				expect(
					idOf(
						rows(
							yield* apply([report], ["--yes"], {
								interceptFetch: async (next, request) => {
									if (
										request.method === "POST" &&
										new URL(request.url).pathname === "/v1/automations"
									) {
										expect(request.headers.get("idempotency-key")).toBe(originalKey)
										expect(await request.clone().json()).toEqual(originalBody)
									}
									return next(request)
								},
							}),
						),
						report,
					),
				).toBe(id)
				const current = yield* run(["automations", "retrieve", "--automation-id", id ?? ""])
				expect(JSON.parse(current.stdout)).toMatchObject({ agent: { id: agent, version: 2 } })
				expect(yield* readLock).not.toHaveProperty("pending_creates")
				expect(rows(yield* apply([])).every(({ action }) => action === "unchanged")).toBe(true)
			}),
		),
	))

it("clears a replayed create rejected before any agent was created", () =>
	Effect.runPromise(
		testProject(({ apply, write, readLock }) =>
			Effect.gen(function* () {
				yield* write(reporter, "name: Reporter\nmodel: unsupported-fixture\n")
				const interrupted = yield* apply([reporter], ["--yes"], {
					interceptFetch: () => Promise.reject(new Error("Connection lost before send.")),
				})
				expect(interrupted.exitCode).toBe(RETRY_EXIT_CODE)
				expect(yield* readLock).toHaveProperty("pending_creates")

				const rejected = yield* apply([reporter])
				expect(rejected.exitCode).toBe(1)
				expect(rejected.stderr).toContain("Unsupported model")
				expect(yield* readLock).not.toHaveProperty("pending_creates")

				yield* write(reporter, agentSource("Reporter"))
				expect(rows(yield* apply([reporter]))[0]?.action).toBe("create")
			}),
		),
	))

it("keeps nested project definitions out of the parent discovery scope", () =>
	Effect.runPromise(
		testProject(({ apply, write, file, run }) =>
			Effect.gen(function* () {
				yield* write(reporter, agentSource("Reporter"))
				const nested = "export"
				yield* write(`${nested}/${reporter}`, agentSource("Already managed"))
				const nestedLock = file(`${nested}/checkfu-lock.json`)
				const nestedRows = rows(
					yield* run(["apply", "--lock-file", nestedLock, "--yes", file(nested)]),
				)
				expect(nestedRows).toHaveLength(1)
				expect(rows(yield* apply(["."], ["--dry-run"])).map(({ file }) => file)).toEqual([
					`./${reporter}`,
				])
				for (const input of [nested, `${nested}/${reporter}`]) {
					const explicit = yield* apply([input], ["--dry-run"])
					expect(explicit.exitCode).toBe(USAGE_EXIT_CODE)
					expect(explicit.stderr).toContain("nested project")
					expect(explicit.stderr).toContain(nestedLock)
				}
				expect(
					rows(yield* run(["apply", "--lock-file", nestedLock, "--dry-run"]))[0],
				).toMatchObject({
					action: "unchanged",
					id: idOf(nestedRows, reporter),
				})
			}),
		),
	))

it("blocks pruning a dependency used by an automation outside the project", () =>
	Effect.runPromise(
		testProject((project) =>
			Effect.gen(function* () {
				const { apply, write, file, run, fs } = project
				yield* standardProject(project)
				const dependencies = rows(yield* apply([reporter, cloud]))
				const agent = idOf(dependencies, reporter)
				const environment = idOf(dependencies, cloud)
				const other = `separate/${report}`
				yield* write(other, reportSource("Separate", agent, environment))
				const external = idOf(
					rows(
						yield* run([
							"apply",
							"--lock-file",
							file("separate/checkfu-lock.json"),
							"--yes",
							file(other),
						]),
					),
					report,
				)
				yield* fs.remove(file(reporter))
				yield* fs.remove(file(cloud))
				const cursors: Array<string | null> = []
				const rejected = yield* apply([reporter, cloud], ["--yes", "--prune"], {
					interceptFetch: (next, request) => {
						expect(request.method).toBe("GET")
						const url = new URL(request.url)
						if (url.pathname !== "/v1/automations") {
							return next(request)
						}
						const cursor = url.searchParams.get("page")
						cursors.push(cursor)
						if (cursor === null) {
							return Promise.resolve(Response.json({ data: [], next_page: "1:fixture" }))
						}
						url.searchParams.delete("page")
						return next(new Request(url, { headers: request.headers }))
					},
				})
				expect(cursors).toEqual([null, "1:fixture"])
				expect(rejected.exitCode).toBe(USAGE_EXIT_CODE)
				expect(rejected.stderr).toContain(`./${reporter}: Automation dependencies in ${external}`)
				expect(rejected.stderr).toContain(`./${cloud}: Automation dependencies in ${external}`)

				let listings = 0
				const late = yield* apply([reporter], ["--yes", "--prune"], {
					interceptFetch: async (next, request) => {
						if (new URL(request.url).pathname === "/v1/automations") {
							listings++
							return Response.json({ data: [], next_page: null })
						}
						const response = await next(request)
						if (request.method === "POST") {
							expect(request.url).toContain("/archive")
							expect(response.status).toBe(409)
						}
						return response
					},
				})
				expect(listings).toBe(1)
				expect(late.exitCode).toBe(CONFLICT_EXIT_CODE)
				expect(late.stderr).toContain(`Automation ${external} still references this resource`)
			}),
		),
	))

it("clears a pending create only when a not-found response identifies admission rejection", () =>
	Effect.runPromise(
		testProject((project) =>
			Effect.gen(function* () {
				const { apply, write, readLock } = project
				yield* standardProject(project)
				const dependencies = rows(yield* apply([reporter, cloud]))
				const agent = idOf(dependencies, reporter)
				yield* write(report, reportSource("Report", agent, "missing-environment"))
				const interrupted = yield* apply([report], ["--yes"], {
					interceptFetch: (next, request) =>
						request.method === "POST"
							? Promise.reject(new Error("Connection lost before send."))
							: next(request),
				})
				expect(interrupted.exitCode).toBe(RETRY_EXIT_CODE)
				expect(yield* readLock).toHaveProperty("pending_creates")

				const ambiguous = yield* apply([report], ["--yes"], {
					interceptFetch: (next, request) =>
						request.method !== "POST"
							? next(request)
							: Promise.resolve(
									Response.json(
										{
											type: "error",
											error: { type: "not_found_error", message: "Endpoint not found." },
											request_id: "req_fixture",
										},
										{ status: 404 },
									),
								),
				})
				expect(ambiguous.exitCode).toBe(NOT_FOUND_EXIT_CODE)
				expect(yield* readLock).toHaveProperty("pending_creates")

				const rejected = yield* apply([report])
				expect(rejected.exitCode).toBe(NOT_FOUND_EXIT_CODE)
				expect(rejected.stderr).toContain("Environment does not exist")
				expect(yield* readLock).not.toHaveProperty("pending_creates")

				yield* write(report, reportSource("Report", agent, idOf(dependencies, cloud)))
				expect(rows(yield* apply([report]))[0]?.action).toBe("create")
			}),
		),
	))

it.each([true, false])(
	"blocks scoped pruning of literal IDs in a pending create (environment path: %s)",
	(usePath) =>
		Effect.runPromise(
			testProject((project) =>
				Effect.gen(function* () {
					const { apply, write, fs, file, readLock } = project
					yield* standardProject(project)
					const dependencies = rows(yield* apply([reporter, cloud]))
					const agent = idOf(dependencies, reporter)
					const environment = idOf(dependencies, cloud)
					yield* write(
						report,
						reportSource("Report", agent, usePath ? "../environments/cloud.yaml" : environment),
					)
					const interrupted = yield* apply([report], ["--yes"], {
						interceptFetch: (next, request) =>
							request.method === "POST"
								? Promise.reject(new Error("Connection lost before send."))
								: next(request),
					})
					expect(interrupted.exitCode).toBe(RETRY_EXIT_CODE)
					expect(yield* readLock).toMatchObject({
						pending_creates: {
							[`./${report}`]: {
								dependencies: {
									agent: { id: agent },
									environment_id: { id: environment },
								},
							},
						},
					})
					yield* fs.remove(file(reporter))
					const refused = yield* apply([reporter], ["--yes", "--prune"])
					expect(refused.exitCode).toBe(USAGE_EXIT_CODE)
					expect(refused.stderr).toContain(`Automation dependencies in ./${report}`)
					yield* write(reporter, agentSource("Reporter"))
					expect(rows(yield* apply([report])).at(-1)?.action).toBe("create")
				}),
			),
		),
)

it("rechecks an unchanged dependency immediately before using it", () =>
	Effect.runPromise(
		testProject((project) =>
			Effect.gen(function* () {
				const { apply, readLock } = project
				yield* standardProject(project)
				const environment = idOf(rows(yield* apply([reporter, cloud])), cloud)
				const endpoint = `/v1/environments/${environment}`
				let reads = 0
				const result = yield* apply([report], ["--yes"], {
					interceptFetch: async (next, request) => {
						expect(request.method).toBe("GET")
						if (new URL(request.url).pathname === endpoint && ++reads === 2) {
							const headers = new Headers(request.headers)
							headers.set("content-type", "application/json")
							const updated = await next(
								new Request(new URL(endpoint, request.url), {
									method: "POST",
									headers,
									body: JSON.stringify({ version: 1, name: "Changed during approval" }),
								}),
							)
							expect(updated.status).toBe(200)
						}
						return next(request)
					},
				})
				expect(reads).toBe(2)
				expect(result.exitCode).toBe(USAGE_EXIT_CODE)
				expect(result.stderr).toContain(`./${cloud}: the resource changed after planning`)
				expect(yield* readLock).not.toHaveProperty("pending_creates")
			}),
		),
	))

it("skips JSON Schemas during directory discovery and rejects selecting them explicitly", () =>
	Effect.runPromise(
		testProject(({ apply, write }) =>
			Effect.gen(function* () {
				const schema = "public/schemas/apply/agent.json"
				yield* write(
					schema,
					JSON.stringify({
						$schema: "https://json-schema.org/draft/2020-12/schema",
						type: "object",
						properties: { name: { type: "string" } },
					}),
				)
				yield* write(reporter, agentSource("Reporter"))
				expect(rows(yield* apply(["."], ["--dry-run"])).map(({ file }) => file)).toEqual([
					`./${reporter}`,
				])
				const explicit = yield* apply([schema], ["--dry-run"])
				expect(explicit.exitCode).toBe(USAGE_EXIT_CODE)
				expect(explicit.stderr).toContain("found a JSON Schema")
			}),
		),
	))

it("clears a pending create after replay definitively rejects its schedule", () =>
	Effect.runPromise(
		testProject((project) =>
			Effect.gen(function* () {
				const { apply, write, readLock } = project
				yield* standardProject(project)
				expect(rows(yield* apply([reporter, cloud]))).toHaveLength(2)
				yield* write(report, reportSource("Report").replace("0 9 * * *", "* * * * *"))
				const lost = yield* apply([report], ["--yes"], {
					interceptFetch: async (next, request) => {
						if (request.method !== "POST") {
							return next(request)
						}
						expect((await next(request)).status).toBe(400)
						throw new Error("Connection lost before reading the rejection.")
					},
				})
				expect(lost.exitCode).toBe(RETRY_EXIT_CODE)
				expect(yield* readLock).toHaveProperty("pending_creates")
				const rejected = yield* apply([report])
				expect(rejected.exitCode).toBe(1)
				expect(rejected.stderr).toContain("The schedule must be a cron expression")
				expect(yield* readLock).not.toHaveProperty("pending_creates")
				yield* write(report, reportSource("Report"))
				expect(rows(yield* apply([report])).at(-1)?.action).toBe("create")
			}),
		),
	))
