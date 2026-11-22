import { readFileSync, writeFileSync } from "node:fs"
import { argv, exit, stderr, stdout } from "node:process"
import * as Effect from "effect/Effect"
import { LOCK_FILE_URL, cutBaseline, decodeLock, lockProblems, shipBlockers } from "./Lock.ts"
import { registryProblems } from "./Shapes.ts"

const fail = (message: string): never => {
	stderr.write(`${message}\n`)
	return exit(1)
}

const now = new Date()
const checkOnly = argv.includes("--check")
const given =
	argv
		.slice(2)
		.find((arg) => !arg.startsWith("--"))
		?.trim() ?? ""
const label = given.length > 0 ? given : `${now.toISOString().slice(0, 19).replaceAll(":", "-")}Z`

const registry = registryProblems()
if (registry.length > 0) {
	fail(`The persisted-shape registry is broken:\n${registry.map((p) => `  - ${p}`).join("\n")}`)
}

const lock = await Effect.runPromise(
	decodeLock(JSON.parse(readFileSync(LOCK_FILE_URL, "utf8")) as unknown).pipe(
		Effect.catch((message) => Effect.sync(() => fail(message))),
	),
)

const blockers = await Effect.runPromise(
	shipBlockers(lock).pipe(Effect.catch((message) => Effect.sync(() => fail(message)))),
)
const latest = lock.baselines.at(-1)
if (blockers.length === 0 && latest !== undefined) {
	stdout.write(`No persisted shape changed since "${latest.label}"; nothing to cut.\n`)
	exit(0)
}

if (checkOnly) {
	fail(
		`${blockers.map((blocker) => `  - ${blocker}`).join("\n")}\nRun \`bun run persisted:cut\`, commit Persisted.lock.json, then deploy.`,
	)
}

const unreadable = await Effect.runPromise(lockProblems(lock))
if (unreadable.length > 0) {
	fail(
		`The current code cannot read an earlier baseline, so no new one was cut:\n${unreadable
			.map((p) => `  - ${p}`)
			.join("\n")}`,
	)
}

if (lock.baselines.some((existing) => existing.label === label)) {
	fail(`A baseline labelled "${label}" already exists. Baselines are never rewritten.`)
}

const baseline = await Effect.runPromise(
	cutBaseline(label, now.toISOString()).pipe(
		Effect.catch((message) => Effect.sync(() => fail(message))),
	),
)

writeFileSync(
	LOCK_FILE_URL,
	`${JSON.stringify({ ...lock, baselines: [...lock.baselines, baseline] }, null, "\t")}\n`,
)
stdout.write(
	`Cut baseline "${label}": ${Object.keys(baseline.shapes).length} persisted shapes locked.\n`,
)
