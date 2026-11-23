import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as Argument from "effect/cli/Argument"
import * as Command from "effect/cli/Command"
import * as Flag from "effect/cli/Flag"
import * as Console from "effect/Console"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Runtime from "effect/Runtime"
import {
	PersistedLockError,
	PersistedServicesLive,
	checkShippedBaseline,
	cutBaseline,
	lockProblems,
	readLockFile,
	shipBlockers,
	writeLockFile,
} from "./Lock.ts"
import { registryProblems } from "./Shapes.ts"

const bullets = (problems: ReadonlyArray<string>) =>
	problems.map((problem) => `  - ${problem}`).join("\n")

const cut = Command.make(
	"cut",
	{
		check: Flag.Boolean("check").pipe(
			Flag.withDefault(false),
			Flag.withDescription("Report whether a new baseline is needed without writing one"),
		),
		label: Argument.String("label").pipe(
			Argument.withDescription("Name of the baseline (defaults to the current UTC time)"),
			Argument.optional,
		),
	},
	(input) =>
		Effect.gen(function* () {
			const nowIso = DateTime.formatIso(yield* DateTime.now)
			const label = Option.getOrElse(
				Option.filter(
					Option.map(input.label, (given) => given.trim()),
					(given) => given.length > 0,
				),
				() => `${nowIso.slice(0, 19).replaceAll(":", "-")}Z`,
			)

			const registry = registryProblems()
			if (registry.length > 0) {
				return yield* new PersistedLockError({
					message: `The persisted-shape registry is broken:\n${bullets(registry)}`,
				})
			}

			const lock = yield* readLockFile
			const blockers = yield* shipBlockers(lock)
			const latest = lock.baselines.at(-1)
			if (latest !== undefined && blockers.length === 0) {
				yield* Console.log(`No persisted shape changed since "${latest.label}"; nothing to cut.`)
				return
			}

			if (input.check) {
				return yield* new PersistedLockError({
					message: `${bullets(blockers)}\nRun \`bun run persisted:cut\`, commit Persisted.lock.json, then deploy.`,
				})
			}

			const unreadable = yield* lockProblems(lock)
			if (unreadable.length > 0) {
				return yield* new PersistedLockError({
					message: `The current code cannot read an earlier baseline, so no new one was cut:\n${bullets(unreadable)}`,
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
		}),
).pipe(Command.withDescription("Lock the current persisted shapes as a new baseline"))

const check = Command.make("check", {}, () => checkShippedBaseline).pipe(
	Command.withDescription("Fail unless the latest baseline is current and committed"),
)

const persisted = Command.make("persisted").pipe(Command.withSubcommands([cut, check]))

export const runPersisted = (args?: ReadonlyArray<string>) =>
	(args === undefined
		? Command.run(persisted, { version: "0.0.0" })
		: Command.runWith(persisted, { version: "0.0.0" })(args)
	).pipe(
		Effect.catchTag("PersistedLockError", (error) =>
			Console.error(error.message).pipe(
				Effect.andThen(Effect.fail({ [Runtime.errorReported]: false })),
			),
		),
	)

if (import.meta.main) {
	BunRuntime.runMain(runPersisted().pipe(Effect.provide(PersistedServicesLive)))
}
