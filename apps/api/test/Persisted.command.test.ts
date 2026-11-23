import { describe, expect, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as Runtime from "effect/Runtime"
import * as Schema from "effect/Schema"
import * as TestConsole from "effect/testing/TestConsole"
import { PersistedLockJson, PersistedServicesLive } from "./persisted/Lock.ts"
import type { PersistedLock } from "./persisted/Lock.ts"
import { runPersisted } from "./persisted/main.ts"

const EMPTY: PersistedLock = { version: 1, retired: {}, reviewed: {}, baselines: [] }

const makeLockFile = (initial: PersistedLock = EMPTY) => {
	let content = Schema.encodeSync(PersistedLockJson)(initial)
	let writes = 0
	return {
		read: () => Schema.decodeSync(PersistedLockJson)(content),
		write: (lock: PersistedLock) => {
			content = Schema.encodeSync(PersistedLockJson)(lock)
		},
		writes: () => writes,
		run: (...args: ReadonlyArray<string>) =>
			runPersisted(args).pipe(
				Effect.provide([
					PersistedServicesLive,
					FileSystem.layerNoop({
						readFileString: () => Effect.succeed(content),
						writeFileString: (_path, data) =>
							Effect.sync(() => {
								content = data
								writes += 1
							}),
					}),
				]),
				Effect.exit,
			),
	}
}

const printed = (lines: ReadonlyArray<unknown>) => lines.map(String).join("\n")

describe("persisted command", () => {
	it.effect("cuts a baseline with no flags, then finds nothing more to cut", () =>
		Effect.gen(function* () {
			const lock = makeLockFile()

			expect(Exit.isSuccess(yield* lock.run("cut", "first"))).toBe(true)
			expect(lock.read().baselines.map((baseline) => baseline.label)).toEqual(["first"])
			expect(Object.keys(lock.read().baselines[0]?.shapes ?? {}).length).toBeGreaterThan(0)

			expect(Exit.isSuccess(yield* lock.run("cut"))).toBe(true)
			expect(lock.writes()).toBe(1)
			expect(printed(yield* TestConsole.logLines)).toContain(
				'No persisted shape changed since "first"; nothing to cut.',
			)
		}),
	)

	it.effect("cut --check reports whether a cut is needed and never writes", () =>
		Effect.gen(function* () {
			const lock = makeLockFile()

			expect(Exit.isFailure(yield* lock.run("cut", "--check"))).toBe(true)
			expect(printed(yield* TestConsole.errorLines)).toContain("No baseline has been cut yet.")
			expect(lock.writes()).toBe(0)

			yield* lock.run("cut", "first")
			expect(Exit.isSuccess(yield* lock.run("cut", "--check"))).toBe(true)
			expect(Exit.isSuccess(yield* lock.run("cut", "label-before-flag", "--check"))).toBe(true)

			const cut = lock.read()
			const [shape] = Object.keys(cut.baselines[0]?.schemas ?? {})
			if (cut.baselines[0] === undefined || shape === undefined) {
				return expect.unreachable("the cut wrote no shapes")
			}
			lock.write({
				...cut,
				baselines: [
					{
						...cut.baselines[0],
						schemas: { ...cut.baselines[0].schemas, [shape]: "0".repeat(64) },
					},
				],
			})
			expect(Exit.isFailure(yield* lock.run("cut", "--check"))).toBe(true)
			expect(printed(yield* TestConsole.errorLines)).toContain(
				`${shape} changed since baseline "first"`,
			)
			expect(lock.writes()).toBe(1)
		}),
	)

	it.effect("check refuses a lock with no baseline", () =>
		Effect.gen(function* () {
			const lock = makeLockFile()

			expect(Exit.isFailure(yield* lock.run("check"))).toBe(true)
			const errors = printed(yield* TestConsole.errorLines)
			expect(errors).toContain("Production deploy refused:")
			expect(errors).toContain("No baseline has been cut yet.")
		}),
	)

	it.effect(
		"prints a refusal once and leaves an unexpected failure for the runtime to report",
		() =>
			Effect.gen(function* () {
				const refusal = yield* makeLockFile().run("cut", "--check")
				expect(yield* TestConsole.errorLines).toHaveLength(1)
				expect(Exit.isFailure(refusal) && Cause.squash(refusal.cause)).toEqual({
					[Runtime.errorReported]: false,
				})

				const defect = yield* runPersisted(["cut"]).pipe(
					Effect.provide([
						PersistedServicesLive,
						FileSystem.layerNoop({ readFileString: () => Effect.die(new Error("disk on fire")) }),
					]),
					Effect.exit,
				)
				expect(Exit.isFailure(defect) && Cause.hasDies(defect.cause)).toBe(true)
				expect(Exit.isFailure(defect) && Cause.pretty(defect.cause)).toContain("disk on fire")
			}),
	)
})
