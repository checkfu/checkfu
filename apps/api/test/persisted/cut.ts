import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as Console from "effect/Console"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Runtime from "effect/Runtime"
import * as Stdio from "effect/Stdio"
import {
	PersistedLockError,
	PersistedServicesLive,
	cutBaseline,
	lockProblems,
	readLockFile,
	shipBlockers,
	writeLockFile,
} from "./Lock.ts"
import { registryProblems } from "./Shapes.ts"

const program = Effect.gen(function* () {
	const now = yield* DateTime.now
	const nowIso = DateTime.formatIso(now)
	const stdio = yield* Stdio.Stdio
	const args = yield* stdio.args
	const unknownFlag = args.find((arg) => arg.startsWith("--") && arg !== "--check")
	if (unknownFlag !== undefined) {
		return yield* new PersistedLockError({
			message: `Unknown flag "${unknownFlag}". Supported flags: --check`,
		})
	}
	const checkOnly = args.includes("--check")
	const given = args.find((arg) => !arg.startsWith("--"))?.trim() ?? ""
	const label = given.length > 0 ? given : `${nowIso.slice(0, 19).replaceAll(":", "-")}Z`

	const registry = registryProblems()
	if (registry.length > 0) {
		return yield* new PersistedLockError({
			message: `The persisted-shape registry is broken:\n${registry.map((p) => `  - ${p}`).join("\n")}`,
		})
	}

	const lock = yield* readLockFile
	const blockers = yield* shipBlockers(lock)
	const latest = lock.baselines.at(-1)
	if (blockers.length === 0 && latest !== undefined) {
		yield* Console.log(`No persisted shape changed since "${latest.label}"; nothing to cut.`)
		return
	}

	if (checkOnly) {
		return yield* new PersistedLockError({
			message: `${blockers.map((blocker) => `  - ${blocker}`).join("\n")}\nRun \`bun run persisted:cut\`, commit Persisted.lock.json, then deploy.`,
		})
	}

	const unreadable = yield* lockProblems(lock)
	if (unreadable.length > 0) {
		return yield* new PersistedLockError({
			message: `The current code cannot read an earlier baseline, so no new one was cut:\n${unreadable
				.map((p) => `  - ${p}`)
				.join("\n")}`,
		})
	}

	if (lock.baselines.some((existing) => existing.label === label)) {
		return yield* new PersistedLockError({
			message: `A baseline labelled "${label}" already exists. Baselines are never rewritten.`,
		})
	}

	const baseline = yield* cutBaseline(label, nowIso)
	yield* writeLockFile({ ...lock, baselines: [...lock.baselines, baseline] })
	yield* Console.log(
		`Cut baseline "${label}": ${Object.keys(baseline.shapes).length} persisted shapes locked.`,
	)
})

const main = () => {
	BunRuntime.runMain(
		program.pipe(
			Effect.catch((error) =>
				Console.error(error.message).pipe(
					Effect.andThen(Effect.fail({ [Runtime.errorReported]: false })),
				),
			),
			Effect.provide(PersistedServicesLive),
		),
	)
}

main()
