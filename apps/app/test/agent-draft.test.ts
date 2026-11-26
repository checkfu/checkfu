import type { JsonAgent } from "@checkfu/sdk/client"
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	bodyOf,
	changesFrom,
	draftOf,
	emptyDraft,
	hasProblems,
	newServer,
	problemsOf,
	rebase,
	withoutServer,
	withServer,
} from "../src/agent-draft.ts"
import type { AgentDraft, ServerDraft } from "../src/agent-draft.ts"

const agent = (
	version: number,
	fields: Partial<Pick<JsonAgent, "name" | "system" | "description" | "mcp_servers" | "tools">>,
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
			servers: [],
			customTools: [],
		})
		expect(rebased.overlapping).toEqual(["system prompt"])
		expect(rebased.orphaned).toEqual([])
		expect(changesFrom(latest, rebased.draft)).toEqual({
			system: "Be thorough.",
			description: "Mine",
		})
	})
})

const rowNamed = (draft: AgentDraft, name: string): ServerDraft => {
	const found = draft.servers.find((server) => server.name === name)
	if (found === undefined) {
		throw new Error(`No server row named ${name}.`)
	}
	return found
}

const tooled = agent(4, {
	mcp_servers: [
		{ type: "url", name: "github", url: "https://mcp.github.com/mcp" },
		{ type: "url", name: "linear", url: "https://mcp.linear.app/mcp" },
	],
	tools: [
		{
			type: "mcp_toolset",
			mcp_server_name: "github",
			default_config: { permission_policy: { type: "always_ask" } },
			configs: [{ name: "search_code", permission_policy: { type: "always_allow" } }],
		},
		{
			type: "custom",
			name: "lookup_customer",
			description: "Find a customer by email.",
			input_schema: { type: "object", properties: { email: { type: "string" } } },
		},
	],
})

describe("agent drafts with MCP servers and tools", () => {
	it("keeps a stored toolset exactly as saved when another tool is edited", () => {
		const stored = agent(1, {
			mcp_servers: [
				{ type: "url", name: "github", url: "https://mcp.github.com/mcp" },
				{ type: "url", name: "linear", url: "https://mcp.linear.app/mcp" },
			],
			tools: [
				{
					type: "mcp_toolset",
					mcp_server_name: "github",
					configs: [
						{ name: "search" },
						{ name: "delete_repo", permission_policy: { type: "always_ask" } },
					],
				},
				{ type: "mcp_toolset", mcp_server_name: "linear" },
			],
		})
		const draft = draftOf(stored)
		const [github, linear] = draft.servers
		if (github === undefined || linear === undefined) {
			throw new Error("both servers are drafted")
		}
		const edited = withServer(draft, { ...linear, fallback: "always_allow" })
		const changes = changesFrom(stored, edited)
		expect(changes.tools).toEqual([
			stored.tools[0],
			{
				type: "mcp_toolset",
				mcp_server_name: "linear",
				default_config: { permission_policy: { type: "always_allow" } },
			},
		])
		const tuned = withServer(draft, {
			...github,
			overrides: github.overrides.map((override) =>
				override.name === "delete_repo"
					? { ...override, policy: "always_allow" as const }
					: override,
			),
		})
		expect(changesFrom(stored, tuned).tools?.[0]).toEqual({
			type: "mcp_toolset",
			mcp_server_name: "github",
			configs: [
				{ name: "search" },
				{ name: "delete_repo", permission_policy: { type: "always_allow" } },
			],
		})
		expect(changesFrom(stored, tuned).tools).toHaveLength(1)
	})

	it("round-trips servers, permissions and custom tools to the request body", () => {
		const body = bodyOf(draftOf(tooled))
		expect(body.mcp_servers).toEqual(tooled.mcp_servers)
		expect(body.tools).toEqual(tooled.tools)
		expect(changesFrom(tooled, draftOf(tooled))).toEqual({})
	})

	it("builds a new agent's servers and tools from what was typed", () => {
		const draft = {
			...emptyDraft,
			name: "Triage",
			model: "claude-sonnet-5-5",
			servers: [
				{
					row: "new:1",
					name: " github ",
					url: " https://mcp.github.com/mcp ",
					fallback: "always_allow" as const,
					overrides: [{ name: " delete_repo ", policy: "always_ask" as const }],
					stored: undefined,
				},
			],
			customTools: [{ name: "ping", description: " Says pong. ", schema: '{"type":"object"}' }],
		}
		expect(hasProblems(problemsOf(draft))).toBe(false)
		expect(bodyOf(draft)).toMatchObject({
			mcp_servers: [{ type: "url", name: "github", url: "https://mcp.github.com/mcp" }],
			tools: [
				{
					type: "mcp_toolset",
					mcp_server_name: "github",
					default_config: { permission_policy: { type: "always_allow" } },
					configs: [{ name: " delete_repo ", permission_policy: { type: "always_ask" } }],
				},
				{
					type: "custom",
					name: "ping",
					description: "Says pong.",
					input_schema: { type: "object" },
				},
			],
		})
	})

	it("keeps a permission override's tool name exactly as the API holds it when another tool is edited", () => {
		const spaced = agent(1, {
			mcp_servers: [{ type: "url", name: "github", url: "https://mcp.github.com/mcp" }],
			tools: [
				{
					type: "mcp_toolset",
					mcp_server_name: "github",
					configs: [
						{ name: " delete_repo ", permission_policy: { type: "always_ask" } },
						{ name: "merge_pr", permission_policy: { type: "always_ask" } },
					],
				},
			],
		})
		const draft = draftOf(spaced)
		const github = rowNamed(draft, "github")
		const edited = withServer(draft, {
			...github,
			overrides: github.overrides.map((override) =>
				override.name === "merge_pr" ? { ...override, policy: "always_allow" as const } : override,
			),
		})
		expect(changesFrom(spaced, edited)).toEqual({
			mcp_servers: spaced.mcp_servers,
			tools: [
				{
					type: "mcp_toolset",
					mcp_server_name: "github",
					configs: [
						{ name: " delete_repo ", permission_policy: { type: "always_ask" } },
						{ name: "merge_pr", permission_policy: { type: "always_allow" } },
					],
				},
			],
		})
	})

	it("asks for a tool name on a permission override left empty", () => {
		const draft = {
			...emptyDraft,
			servers: [
				{
					...newServer(),
					name: "github",
					url: "https://mcp.github.com/mcp",
					overrides: [{ name: "", policy: "always_ask" as const }],
				},
			],
		}
		expect(problemsOf(draft).servers.get(0)).toBe("Name each tool you set a permission for.")
	})

	it("leaves out a server's permissions when they are the API's default", () => {
		const draft = draftOf(tooled)
		const cleared = withServer(draft, { ...rowNamed(draft, "github"), fallback: "", overrides: [] })
		expect(changesFrom(tooled, cleared)).toEqual({
			mcp_servers: tooled.mcp_servers,
			tools: [tooled.tools[1]],
		})
	})

	it("refuses the server names the API refuses, next to their rows", () => {
		const named = (...names: Array<string>) =>
			problemsOf({
				...emptyDraft,
				servers: names.map((name) => ({ ...newServer(), name, url: "https://mcp.example.com" })),
			}).servers
		expect([...named("git__hub", "_github", "github_", "git hub").keys()]).toEqual([0, 1, 2, 3])
		expect(named("git_hub", "git-hub", "GitHub2").size).toBe(0)
		expect(named("same", "same").get(1)).toContain("already named same")
	})

	it("says when a custom tool's input schema is not a JSON object", () => {
		const problem = (schema: string) =>
			problemsOf({
				...emptyDraft,
				customTools: [{ name: "ping", description: "Pong.", schema }],
			}).customTools.get(0)
		expect(problem("{not json")).toContain("JSON object")
		expect(problem("[]")).toContain("JSON object")
		expect(problem('{"type":"object"}')).toBeUndefined()
	})
})

const toolsetOf = (draft: AgentDraft, name: string) =>
	bodyOf(draft).tools.find((tool) => tool.type === "mcp_toolset" && tool.mcp_server_name === name)

const urlServer = (name: string, url = `https://${name}.example.com/mcp`) => ({
	type: "url" as const,
	name,
	url,
})

describe("a server's permissions stay on its row", () => {
	const git = agent(1, {
		mcp_servers: [urlServer("git")],
		tools: [
			{
				type: "mcp_toolset",
				mcp_server_name: "git",
				default_config: { permission_policy: { type: "always_allow" } },
			},
		],
	})

	it("keeps git's rule on git while a new server is typed past its name to github", () => {
		const added = newServer()
		let draft: AgentDraft = { ...draftOf(git), servers: [...draftOf(git).servers, added] }
		for (const typed of ["g", "gi", "git", "gith", "github"]) {
			draft = withServer(draft, { ...added, name: typed, url: "https://github.example.com/mcp" })
			expect(draft.servers[0]).toEqual(draftOf(git).servers[0])
		}
		expect(toolsetOf(draft, "git")).toEqual(git.tools[0])
		expect(toolsetOf(draft, "github")).toBeUndefined()
		expect(changesFrom(git, draft)).toEqual({
			mcp_servers: [...git.mcp_servers, urlServer("github")],
			tools: git.tools,
		})
	})

	it("sends the tools with a server change, so a default-only toolset never outlives its server", () => {
		const stored = agent(1, {
			mcp_servers: [urlServer("git"), urlServer("docs")],
			tools: [{ type: "mcp_toolset", mcp_server_name: "docs" }],
		})
		const draft = draftOf(stored)
		expect(changesFrom(stored, withoutServer(draft, rowNamed(draft, "docs").row))).toEqual({
			mcp_servers: [urlServer("git")],
			tools: [],
		})
		expect(
			changesFrom(stored, withServer(draft, { ...rowNamed(draft, "docs"), name: "wiki" })),
		).toEqual({
			mcp_servers: [urlServer("git"), urlServer("wiki", "https://docs.example.com/mcp")],
			tools: [],
		})
	})

	it("takes a row's rule with it when the row is renamed, and away when it is removed", () => {
		const draft = draftOf(git)
		const renamed = withServer(draft, { ...rowNamed(draft, "git"), name: "scm" })
		expect(toolsetOf(renamed, "scm")).toEqual({ ...git.tools[0], mcp_server_name: "scm" })
		expect(toolsetOf(renamed, "git")).toBeUndefined()
		expect(bodyOf(withoutServer(draft, rowNamed(draft, "git").row)).tools).toEqual([])
	})
})

describe("carrying server edits onto a newer version", () => {
	const docs = agent(1, { mcp_servers: [urlServer("docs"), urlServer("mail")] })
	const asking = (draft: AgentDraft, name: string): AgentDraft =>
		withServer(draft, { ...rowNamed(draft, name), fallback: "always_ask" })

	it("names a server this editor changed that the newer version renamed, and never says it was kept", () => {
		const latest = agent(2, {
			mcp_servers: [urlServer("wiki", "https://docs.example.com/mcp"), urlServer("mail")],
		})
		const rebased = rebase(docs, asking(draftOf(docs), "docs"), latest)
		expect(rebased.orphaned).toEqual(["docs"])
		expect(rebased.overlapping).toEqual([])
		expect(rebased.draft.servers.map((server) => server.name)).toEqual(["wiki", "mail", "docs"])
		expect(rowNamed(rebased.draft, "docs").fallback).toBe("always_ask")
		expect(rowNamed(rebased.draft, "wiki").fallback).toBe("")
		expect(rebase(latest, rebased.draft, latest).orphaned).toEqual([])
	})

	it("names a server this editor changed that the newer version removed", () => {
		const latest = agent(2, { mcp_servers: [urlServer("mail")] })
		expect(rebase(docs, asking(draftOf(docs), "docs"), latest).orphaned).toEqual(["docs"])
	})

	it("carries an edit to one server past a change to another without a word", () => {
		const latest = agent(2, {
			mcp_servers: [urlServer("docs"), urlServer("mail", "https://mail2.example.com/mcp")],
		})
		const rebased = rebase(docs, asking(draftOf(docs), "docs"), latest)
		expect(rebased.overlapping).toEqual([])
		expect(rebased.orphaned).toEqual([])
		expect(changesFrom(latest, rebased.draft)).toEqual({
			mcp_servers: latest.mcp_servers,
			tools: [
				{
					type: "mcp_toolset",
					mcp_server_name: "docs",
					default_config: { permission_policy: { type: "always_ask" } },
				},
			],
		})
	})

	it("names a server both changed, and keeps this editor's", () => {
		const latest = agent(2, {
			mcp_servers: [urlServer("docs", "https://docs2.example.com/mcp"), urlServer("mail")],
		})
		const rebased = rebase(docs, asking(draftOf(docs), "docs"), latest)
		expect(rebased.overlapping).toEqual(["MCP server docs"])
		expect(rowNamed(rebased.draft, "docs")).toMatchObject({
			url: "https://docs.example.com/mcp",
			fallback: "always_ask",
		})
	})

	it("follows the newer version where this editor changed nothing", () => {
		const latest = agent(2, { mcp_servers: [urlServer("wiki", "https://docs.example.com/mcp")] })
		const rebased = rebase(docs, { ...draftOf(docs), system: "Mine." }, latest)
		expect(rebased.draft.servers).toEqual(draftOf(latest).servers)
		expect(rebased.orphaned).toEqual([])
		expect(changesFrom(latest, rebased.draft)).toEqual({ system: "Mine." })
	})
})

const policy = fc.constantFrom("always_allow" as const, "always_ask" as const)
const word = fc.stringMatching(/^[a-z][a-z0-9]{0,7}$/u)
const permissions = fc.record({
	fallback: fc.constantFrom("" as const, "always_allow" as const, "always_ask" as const),
	overrides: fc.uniqueArray(fc.record({ name: word, policy }), {
		maxLength: 3,
		selector: (override) => override.name,
	}),
})

const savedAgent = fc
	.record({
		servers: fc.uniqueArray(fc.record({ name: word, permissions }), {
			maxLength: 5,
			selector: (server) => server.name,
		}),
		custom: fc.uniqueArray(word, { maxLength: 3 }),
	})
	.map(({ servers, custom }) =>
		agent(1, {
			name: "Agent",
			mcp_servers: servers.map(({ name }) => urlServer(name)),
			tools: [
				...servers.flatMap(({ name, permissions: { fallback, overrides } }) =>
					fallback === "" && overrides.length === 0
						? []
						: [
								{
									type: "mcp_toolset" as const,
									mcp_server_name: name,
									...(fallback === ""
										? {}
										: { default_config: { permission_policy: { type: fallback } } }),
									...(overrides.length === 0
										? {}
										: {
												configs: overrides.map((override) => ({
													name: override.name,
													permission_policy: { type: override.policy },
												})),
											}),
								},
							],
				),
				...custom.map((name) => ({
					type: "custom" as const,
					name,
					description: `Runs ${name}.`,
					input_schema: { type: "object", properties: { [name]: { type: "string" } } },
				})),
			],
		}),
	)

const permissionsOf = (draft: AgentDraft) =>
	new Map(draft.servers.map(({ row, fallback, overrides }) => [row, { fallback, overrides }]))

type Step =
	| { readonly kind: "rename"; readonly at: number; readonly name: string }
	| {
			readonly kind: "permit"
			readonly at: number
			readonly permissions: Pick<ServerDraft, "fallback" | "overrides">
	  }
	| { readonly kind: "remove"; readonly at: number }
	| { readonly kind: "add"; readonly name: string }

const steps: fc.Arbitrary<ReadonlyArray<Step>> = fc.array(
	fc.oneof(
		fc.record({ kind: fc.constant("rename" as const), at: fc.nat(), name: word }),
		fc.record({ kind: fc.constant("permit" as const), at: fc.nat(), permissions }),
		fc.record({ kind: fc.constant("remove" as const), at: fc.nat() }),
		fc.record({ kind: fc.constant("add" as const), name: word }),
	),
	{ maxLength: 6 },
)

const made = (current: AgentDraft, step: Step, row: string): AgentDraft => {
	if (step.kind === "add") {
		const { name, url } = urlServer(step.name)
		return { ...current, servers: [...current.servers, { ...newServer(), row, name, url }] }
	}
	const target = current.servers[step.at % Math.max(current.servers.length, 1)]
	if (target === undefined) {
		return current
	}
	if (step.kind === "remove") {
		return withoutServer(current, target.row)
	}
	return withServer(
		current,
		step.kind === "rename" ? { ...target, name: step.name } : { ...target, ...step.permissions },
	)
}

const edit = (draft: AgentDraft, all: ReadonlyArray<Step>, who: string): AgentDraft => {
	let current = draft
	all.forEach((step, index) => {
		current = made(current, step, `new:${who}:${index}`)
	})
	return current
}

const fieldsOf = ({ row: _, ...fields }: ServerDraft) => JSON.stringify(fields)

describe("agent drafts, for any agent", () => {
	it("writes back exactly the agent that was read", () => {
		fc.assert(
			fc.property(savedAgent, (saved) => {
				const body = bodyOf(draftOf(saved))
				expect(body.mcp_servers).toEqual(saved.mcp_servers)
				expect(body.tools).toEqual(saved.tools)
				expect(changesFrom(saved, draftOf(saved))).toEqual({})
			}),
		)
	})

	it("reads the same permissions whatever order the API lists the tools in", () => {
		fc.assert(
			fc.property(
				savedAgent.chain((saved) =>
					fc.tuple(
						fc.constant(saved),
						fc.shuffledSubarray([...saved.tools], { minLength: saved.tools.length }),
					),
				),
				([saved, shuffled]) => {
					expect(draftOf({ ...saved, tools: shuffled }).servers).toEqual(draftOf(saved).servers)
				},
			),
		)
	})

	it("never changes any row's permissions when a row is renamed", () => {
		fc.assert(
			fc.property(savedAgent, fc.nat(), fc.string({ maxLength: 12 }), (saved, at, name) => {
				const draft = draftOf(saved)
				const target = draft.servers[at % Math.max(draft.servers.length, 1)]
				if (target === undefined) {
					return
				}
				const renamed = withServer(draft, { ...target, name })
				expect(permissionsOf(renamed)).toEqual(permissionsOf(draft))
				expect(renamed.servers.map((server) => server.row)).toEqual(
					draft.servers.map((server) => server.row),
				)
			}),
		)
	})

	it("never loses an edit to a server without naming that server as a conflict", () => {
		fc.assert(
			fc.property(savedAgent, steps, steps, (base, mySteps, theirSteps) => {
				const was = draftOf(base)
				const mine = edit(was, mySteps, "mine")
				const theirs = edit(was, theirSteps, "theirs")
				fc.pre(!hasProblems(problemsOf(theirs)))
				const { mcp_servers, tools } = bodyOf(theirs)
				const latest = { ...base, version: 2, mcp_servers, tools }
				const current = draftOf(latest)
				const rebased = rebase(base, mine, latest)
				const kept = rebased.draft.servers.map(fieldsOf)
				for (const server of was.servers) {
					const my = mine.servers.find((candidate) => candidate.row === server.row)
					const their = current.servers.find((candidate) => candidate.row === server.row)
					if (my === undefined || fieldsOf(my) === fieldsOf(server)) {
						expect(rebased.orphaned).not.toContain(server.name)
						continue
					}
					expect(kept).toContain(fieldsOf(my))
					if (their === undefined) {
						expect(rebased.orphaned).toContain(server.name)
					} else if (fieldsOf(their) !== fieldsOf(server) && fieldsOf(their) !== fieldsOf(my)) {
						expect(rebased.overlapping).toContain(`MCP server ${server.name}`)
					}
				}
			}),
		)
	})
})
