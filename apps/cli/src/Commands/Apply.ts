import type { ProjectLockfile } from "@checkfu/authoring/lockfile"
import * as Argument from "effect/cli/Argument"
import * as Command from "effect/cli/Command"
import * as Flag from "effect/cli/Flag"
import * as Prompt from "effect/cli/Prompt"
import * as Effect from "effect/Effect"
import * as Path from "effect/Path"
import * as Stdio from "effect/Stdio"
import { usageError } from "../Errors.ts"
import { executePlan } from "../Project/Execute.ts"
import { locateLockfile, readLockfile, withProjectLock } from "../Project/Lockfile.ts"
import { detailedPlan, planProject } from "../Project/Plan.ts"
import { loadProject } from "../Project/Source.ts"
import { getClient, renderOutput } from "../RootCommand.ts"
import { writeStderrLine } from "../TerminalOutput.ts"

const flags = {
	paths: Argument.String("path").pipe(
		Argument.variadic(),
		Argument.withDescription("Resource files or directories"),
	),
	lockFile: Flag.String("lock-file").pipe(
		Flag.optional,
		Flag.withDescription("Use a specific lockfile and project root"),
	),
	dryRun: Flag.Boolean("dry-run").pipe(
		Flag.withDefault(false),
		Flag.withDescription("Show the plan without writing to the deployment or lockfile"),
	),
	yes: Flag.Boolean("yes").pipe(
		Flag.withAlias("y"),
		Flag.withDefault(false),
		Flag.withDescription("Apply without an interactive confirmation"),
	),
	force: Flag.Boolean("force").pipe(
		Flag.withDefault(false),
		Flag.withDescription("Overwrite remote edits or replace archived or deleted resources"),
	),
	prune: Flag.Boolean("prune").pipe(
		Flag.withDefault(false),
		Flag.withDescription("Archive tracked resources whose source files are gone"),
	),
}

const runApply = (lockFile: string, options: Command.Command.Config.Infer<typeof flags>) =>
	Effect.gen(function* () {
		const path = yield* Path.Path
		const root = path.dirname(lockFile)
		const locked = yield* readLockfile(lockFile)
		if (locked === undefined && options.paths.length === 0) {
			return yield* usageError(
				"Name the files or directories to apply, for example `checkfu apply .`.",
			)
		}
		const tracked = new Map(
			Object.entries(locked?.pending_creates ?? {}).map(
				([key, pending]) => [key, pending.kind] as const,
			),
		)
		for (const [key, entry] of Object.entries(locked?.resources ?? {})) {
			tracked.set(key, entry.kind)
		}
		const project = yield* loadProject(root, lockFile, options.paths, tracked, options.prune)
		if (options.paths.length > 0 && project.resources.length === 0 && project.missing.size === 0) {
			return yield* usageError("No resource definitions found.")
		}
		const client = yield* getClient
		const state: ProjectLockfile = locked ?? { version: 1, base_url: client.baseUrl, resources: {} }
		if (state.base_url !== client.baseUrl) {
			return yield* usageError(
				`${lockFile} belongs to ${state.base_url}. Use that API URL or a different --lock-file.`,
			)
		}
		const plan = yield* planProject(client.api, project, state, options)
		if (options.dryRun) {
			return yield* renderOutput(detailedPlan(plan))
		}
		const blocked = plan.rows.filter(({ action }) => action === "blocked")
		if (blocked.length > 0) {
			return yield* usageError(blocked.map(({ file, reason }) => `${file}: ${reason}`).join("\n"))
		}
		if (
			!options.yes &&
			plan.rows.some(({ action }) => action !== "unchanged" && action !== "skipped")
		) {
			const stdio = yield* Stdio.Stdio
			if (!(yield* stdio.stdinIsTerminal) || !(yield* stdio.stdoutIsTerminal)) {
				yield* renderOutput(plan.rows)
				return yield* usageError(
					"Use --yes to apply without a terminal or --dry-run to see the plan.",
				)
			}
			for (const row of plan.rows) {
				const fields = row.fields?.join(", ")
				yield* writeStderrLine(`${row.action} ${row.file}${fields ? ` (${fields})` : ""}`)
			}
			for (;;) {
				const decision = yield* Prompt.Select({
					message: "Apply these changes?",
					choices: [
						{ title: "Cancel", value: "cancel" },
						{ title: "Show details", value: "details" },
						{ title: "Apply changes", value: "apply" },
					],
				}).pipe(
					Effect.mapError(() =>
						usageError(
							"The confirmation prompt was interrupted. Nothing was applied. Use --yes to apply without a prompt.",
						),
					),
				)
				if (decision === "cancel") {
					yield* writeStderrLine("Cancelled. Nothing was applied.")
					return
				}
				if (decision === "apply") {
					break
				}
				yield* renderOutput(detailedPlan(plan))
			}
		}
		const applied = yield* executePlan(client, lockFile, state, plan)
		yield* renderOutput(applied)
	})

export const applyCommand = Command.make("apply", flags, (options) =>
	Effect.gen(function* () {
		const lockFile = yield* locateLockfile(options.lockFile)
		const apply = runApply(lockFile, options)
		yield* options.dryRun ? apply : withProjectLock(lockFile, apply)
	}),
).pipe(
	Command.withDescription(
		"Apply agent, environment and automation definitions from YAML, JSON or Markdown files",
	),
)
