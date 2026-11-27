import { spawn, execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import * as Schema from "effect/Schema"
import { Evidence, RunnerReport, groups, journeys, matrix, surfaces } from "./Verification.ts"
import type { Group, Source } from "./Verification.ts"

const root = resolve(import.meta.dirname, "../..")
const git = (...args: Array<string>) =>
	execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim()
const source = (): Source => {
	const hash = createHash("sha256")
	for (const file of git("ls-files", "-z", "--cached", "--others", "--exclude-standard")
		.split("\0")
		.filter(Boolean)
		.sort()) {
		hash.update(file).update("\0")
		hash
			.update(existsSync(join(root, file)) ? readFileSync(join(root, file)) : "<deleted>")
			.update("\0")
	}
	return {
		commit: git("rev-parse", "HEAD"),
		fingerprint: hash.digest("hex"),
		dirty: git("status", "--porcelain").length > 0,
	}
}

const run = async (group: Group, directory: string) => {
	const spec = groups[group]
	const before = source()
	const startedAt = new Date().toISOString()
	const raw = join(directory, `${group}.vitest.json`)
	await rm(raw, { force: true })
	const args = [
		"run",
		"--cwd",
		join(root, spec.cwd),
		spec.script,
		...spec.files,
		"--tagsFilter",
		"acceptance",
		"--reporter=default",
		"--reporter=json",
		`--outputFile.json=${raw}`,
	]
	const child = spawn("bun", args, {
		cwd: root,
		stdio: "inherit",
		env: { ...process.env, CHECKFU_PROVE: "1" },
	})
	const exitCode = await new Promise<number>((done, reject) => {
		child.once("error", reject)
		child.once("exit", (code) => done(code ?? 1))
	})
	const runner = existsSync(raw)
		? Schema.decodeSync(Schema.fromJsonString(RunnerReport))(await readFile(raw, "utf8"))
		: null
	const evidence: Evidence = {
		group,
		source: before,
		finishedSource: source(),
		startedAt,
		finishedAt: new Date().toISOString(),
		node: execFileSync("node", ["--version"], { encoding: "utf8" }).trim(),
		platform: `${process.platform}/${process.arch}`,
		command: ["bun", ...args],
		exitCode,
		runner,
	}
	await writeFile(join(directory, `${group}.json`), JSON.stringify(evidence, null, 2))
	return evidence
}

const [action = "all", ...inputs] = process.argv.slice(2)
const current = source()
const directory = resolve(
	process.env["CHECKFU_VERIFICATION_DIR"] ??
		join(root, ".checkfu", "verification", `${current.commit}-${Date.now()}`),
)
await mkdir(directory, { recursive: true })
const evidence: Array<Evidence> = []
if (action === "report" || action === "release") {
	for (const file of inputs) {
		evidence.push(Schema.decodeSync(Schema.fromJsonString(Evidence))(await readFile(file, "utf8")))
	}
} else {
	const selected = Object.keys(groups).filter(
		(group): group is Group => group === action || action === "all",
	)
	if (selected.length === 0) {
		throw new Error(
			`Usage: bun run verify [all|${Object.keys(groups).join("|")}|report|release] [evidence.json ...]`,
		)
	}
	for (const group of selected) {
		evidence.push(await run(group, directory))
	}
}
const report = matrix(source(), evidence)
await writeFile(join(directory, "matrix.json"), JSON.stringify(report, null, 2))
const lines = [
	"| User promise | API | MCP | SDK | YAML | UI | CLI |",
	"|---|---|---|---|---|---|---|",
]
for (const row of report.cells) {
	lines.push(
		`| ${row.promise} | ${surfaces.map((surface) => row.surfaces[surface]?.status ?? "unverified").join(" | ")} |`,
	)
}
lines.push(
	"",
	...report.gaps.map((gap) => `- **${gap.status}**: ${gap.id}: ${gap.reason}`),
	"",
	`Release qualified: **${report.releaseQualified}**. Full boundaries, provenance and case results: matrix.json.`,
)
const summary = `${lines.join("\n")}\n`
await writeFile(join(directory, "summary.md"), summary)
const githubSummary = process.env["GITHUB_STEP_SUMMARY"]
if (githubSummary !== undefined) {
	await writeFile(githubSummary, summary, { flag: "a" })
}
process.stdout.write(`Verification evidence: ${directory}\n`)
const selectedCases =
	action === "report" || action === "release"
		? journeys
		: journeys.filter((journey) => evidence.some((run) => run.group === journey.group))
if (
	selectedCases.some(
		(journey) => report.cases.find((row) => row.id === journey.id)?.status !== "passed",
	) ||
	(action === "release" && !report.releaseQualified)
) {
	process.exitCode = 1
}
