import * as Schema from "effect/Schema"

export const surfaces = ["api", "mcp", "sdk", "yaml", "ui", "cli"] as const
type Surface = (typeof surfaces)[number]
export const groups = {
	clients: { cwd: "tools/release", script: "test", files: ["Package.test.ts"] },
	ui: { cwd: "apps/app", script: "test", files: ["test/user-journey.test.tsx"] },
	mcp: { cwd: "apps/mcp", script: "test", files: ["test/Mcp.interoperability.test.ts"] },
	project: {
		cwd: "apps/api",
		script: "test:workerd",
		files: ["test/workerd/PiSession.workerd.ts"],
	},
	machines: {
		cwd: "apps/api",
		script: "test:workerd",
		files: ["test/workerd/PiSessionMachines.workerd.ts"],
	},
	domain: { cwd: "packages/domain", script: "test", files: ["test/Files.verify.test.ts"] },
} as const
export type Group = keyof typeof groups

interface Journey {
	readonly id: string
	readonly group: Group
	readonly promise: string
	readonly surfaces: ReadonlyArray<Surface>
	readonly boundary: string
	readonly notApplicable?: string
}

// Only surfaces that perform the promised action belong here. Reading another
// client's result does not qualify that surface as a second implementation.
export const journeys: ReadonlyArray<Journey> = [
	{
		id: "installed-entrypoints",
		notApplicable: "Only the CLI and SDK distribute npm consumer entry points",
		group: "clients",
		promise:
			"Install candidate packages outside the checkout and use strict TypeScript and JavaScript",
		surfaces: ["cli", "sdk"],
		boundary: "installed candidate tarballs; supported Node; strict NodeNext consumer",
	},
	{
		id: "package-integrity",
		notApplicable: "Only the CLI and SDK are distributed as npm tarballs",
		group: "clients",
		promise: "Reject changed tarballs and ambiguous package identities",
		surfaces: ["cli", "sdk"],
		boundary: "exact candidate record and SHA-512 package bytes",
	},
	{
		id: "installed-journeys",
		group: "clients",
		promise:
			"Use installed clients for login, CRUD, retries, stale edits, version history and event streams",
		surfaces: ["cli", "sdk"],
		boundary:
			"installed candidate tarballs; production HTTP/domain; bounded echo runtime, not agent execution",
	},
	{
		id: "deployment-source",
		group: "clients",
		promise: "Deploy the server revision built with the installed CLI",
		surfaces: ["cli"],
		boundary: "installed candidate CLI; deployment source URL compared with the qualified commit",
		notApplicable: "Only the CLI deploys Checkfu",
	},
	{
		id: "ui-session-admission",
		group: "ui",
		promise: "Correct a refused session without losing the form or admitting partial state",
		surfaces: ["ui"],
		boundary:
			"happy-dom; production router/forms, signed-cookie Worker and HTTP/domain; not a browser",
	},
	{
		id: "ui-agent-conflict",
		group: "ui",
		promise: "Rebase a stale agent edit while preserving tools and historic versions",
		surfaces: ["ui"],
		boundary: "happy-dom; independent competing SDK editor and HTTP/domain",
	},
	{
		id: "ui-memory-conflict",
		group: "ui",
		promise: "Keep a conflicting memory draft until the newer version is loaded",
		surfaces: ["ui"],
		boundary: "happy-dom; independent competing SDK editor and HTTP/domain",
	},
	{
		id: "mcp-uncertain-create",
		group: "mcp",
		promise: "Recover a lost committed create reply without a duplicate or changed intent",
		surfaces: ["mcp"],
		boundary: "independent official MCP clients; protocol negotiation and production HTTP/domain",
	},
	{
		id: "authored-project-cli",
		group: "project",
		promise:
			"Preview, apply, run and prune an authored project while preserving pinned history, output bytes and competing edits",
		surfaces: ["yaml", "cli"],
		boundary:
			"installed candidate CLI with authored Markdown and YAML; independent SDK and HTTP verify stored history and output bytes; local Alchemy Workers, DOs, R2 and sandbox",
	},
	{
		id: "authored-project-mcp",
		group: "project",
		promise:
			"Read automation pins, edit an agent and enforce the revision when CLI and MCP compete",
		surfaces: ["mcp"],
		boundary:
			"independent MCP client reads pins established by CLI apply, writes a competing edit and observes one winning revision; local Alchemy Workers and DOs",
	},
	{
		id: "file-mount",
		group: "machines",
		promise: "Read uploaded files in an agent and retain their bytes after a refused write",
		surfaces: ["api"],
		boundary: "authenticated HTTP; real Workers/storage/sandbox and model protocol fixture",
	},
	{
		id: "artifact-mount",
		group: "machines",
		promise: "Read a pinned artifact as files and refuse writes",
		surfaces: ["api"],
		boundary: "authenticated HTTP; real Workers/storage/sandbox and model protocol fixture",
	},
	{
		id: "skill-mount",
		group: "machines",
		promise: "Tell the agent about a mounted skill and read it with file tools",
		surfaces: ["api"],
		boundary: "authenticated HTTP; real Workers/storage/sandbox and model protocol fixture",
	},
	{
		id: "output-bytes",
		group: "machines",
		promise: "Download exactly the bytes the agent wrote to its outputs directory",
		surfaces: ["api"],
		boundary: "authenticated HTTP; real Workers/storage/sandbox and model protocol fixture",
	},
	{
		id: "agent-mcp-tools",
		group: "machines",
		promise:
			"Discover and call external MCP tools from scripts and directly without exposing credentials",
		surfaces: ["api"],
		boundary:
			"real Workers/sandbox; external MCP protocol servers; not the application's MCP interface",
	},
	{
		id: "mcp-revocation",
		group: "machines",
		promise: "Stop sending a credential once its credential or vault is revoked",
		surfaces: ["api"],
		boundary: "real Workers/sandbox; independent upstream request/token counts",
	},
	{
		id: "file-domain-proof",
		group: "domain",
		promise:
			"Prove file content immutability and output transition invariants with real-handler replay agreement",
		surfaces: [],
		boundary:
			"Alchemy/Z3: 18 required proved invariants; bounded liveness/exploration and replay are separate standings",
	},
]

export const verificationTags = [
	{ name: "acceptance" },
	...journeys.map(({ id }) => ({ name: id })),
]

export const gaps = [
	{
		id: "mcp-oauth-refresh",
		status: "product gap",
		reason: "CredentialAuth supports static bearer credentials, not OAuth refresh.",
		source: "packages/sdk/src/Schemas.ts",
	},
	{
		id: "automation-mounted-context",
		status: "product gap",
		reason: "Automation definitions have no resources or vault_ids for the sessions they create.",
		source: "packages/sdk/src/Api.ts",
	},
	{
		id: "browser-journeys",
		status: "unverified",
		reason:
			"DOM journeys do not verify rendering, browser navigation or browser-specific behavior.",
		source: "apps/app/test/user-journey.test.tsx",
	},
	{
		id: "mounted-admission-proof",
		status: "unverified",
		reason:
			"Mounted file admission is bounded to two items; the full admission report is opt-in and accepts path-limit Unknown verdicts. The artifact/skill guard is proved separately. These do not establish an unbounded full-admission proof.",
		source: "packages/domain/test/MountedSession.verify.test.ts",
	},
] as const

const Assertion = Schema.Struct({
	title: Schema.String,
	fullName: Schema.String,
	status: Schema.String,
	tags: Schema.Array(Schema.String),
	failureMessages: Schema.NullOr(Schema.Array(Schema.String)),
	meta: Schema.Record(Schema.String, Schema.Unknown),
})
export const RunnerReport = Schema.Struct({
	success: Schema.Boolean,
	testResults: Schema.Array(
		Schema.Struct({ name: Schema.String, assertionResults: Schema.Array(Assertion) }),
	),
})
export const Source = Schema.Struct({
	commit: Schema.String,
	fingerprint: Schema.String,
	dirty: Schema.Boolean,
})
export type Source = typeof Source.Type
export const Evidence = Schema.Struct({
	group: Schema.Literals(["clients", "ui", "mcp", "project", "machines", "domain"]),
	source: Source,
	finishedSource: Source,
	startedAt: Schema.String,
	finishedAt: Schema.String,
	node: Schema.String,
	platform: Schema.String,
	command: Schema.Array(Schema.String),
	exitCode: Schema.Int,
	runner: Schema.NullOr(RunnerReport),
})
export type Evidence = typeof Evidence.Type

export const sameSource = (left: Source, right: Source) =>
	left.commit === right.commit &&
	left.fingerprint === right.fingerprint &&
	left.dirty === right.dirty

export const matrix = (source: Source, evidence: ReadonlyArray<Evidence>) => {
	const cases = journeys.map((journey) => {
		const runs = evidence.filter((run) => run.group === journey.group)
		const run = runs[0]
		const current =
			runs.length === 1 &&
			run !== undefined &&
			sameSource(source, run.source) &&
			sameSource(source, run.finishedSource)
		const assertions = current
			? (run.runner?.testResults.flatMap((file) =>
					file.assertionResults
						.filter((test) => test.tags.includes(journey.id))
						.map((test) => ({ ...test, file: file.name })),
				) ?? [])
			: []
		const assertion = assertions[0]
		const expectedFiles = groups[journey.group].files.map(
			(file) => `${groups[journey.group].cwd}/${file}`,
		)
		const registered =
			assertions.length === 1 &&
			assertion !== undefined &&
			assertion.tags.includes("acceptance") &&
			expectedFiles.some((file) => assertion.file.replaceAll("\\", "/").endsWith(`/${file}`))
		const status = !registered
			? "unverified"
			: assertion.status === "failed"
				? "failed"
				: assertion.status === "passed" && run?.exitCode === 0 && run.runner?.success === true
					? "passed"
					: "unverified"
		return {
			...journey,
			status,
			evidence: assertions,
			reason: !current
				? "Missing, duplicate or different-source execution"
				: !registered
					? "Required case missing, duplicated or in the wrong file"
					: status === "unverified"
						? "Case skipped, incomplete or runner failed"
						: null,
		}
	})
	const blockers = [
		...gaps.map((gap) => ({ id: gap.id, reason: gap.reason })),
		...cases.flatMap((row) =>
			row.status !== "passed" ||
			(row.surfaces.length > 0 &&
				row.surfaces.length < surfaces.length &&
				row.notApplicable === undefined)
				? [
						{
							id: row.id,
							reason:
								row.status !== "passed"
									? (row.reason ?? row.status)
									: "Required surface paths have no registered journey",
						},
					]
				: [],
		),
		...(source.dirty ? [{ id: "dirty-source", reason: "Execution used uncommitted source" }] : []),
	]
	return {
		source,
		scope:
			"Registered release-critical journeys, not an inventory of every public capability. Unregistered surface paths remain unverified.",
		cells: cases.flatMap((row) =>
			row.surfaces.length > 0
				? [
						{
							promise: row.promise,
							boundary: row.boundary,
							surfaces: Object.fromEntries(
								surfaces.map((surface) => [
									surface,
									row.surfaces.includes(surface)
										? { status: row.status, cases: [row.id] }
										: row.notApplicable !== undefined
											? { status: "not applicable", reason: row.notApplicable }
											: {
													status: "unverified",
													reason: "No journey registered for this promise on this surface",
												},
								]),
							),
						},
					]
				: [],
		),
		cases,
		gaps,
		blockers,
		releaseQualified: blockers.length === 0,
	}
}
