import * as Alchemist from "alchemy/Alchemist"
import { runMain } from "alchemy/Util/PlatformServices"
import * as Command from "effect/cli/Command"
import * as Flag from "effect/cli/Flag"
import * as Prompt from "effect/cli/Prompt"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Stdio from "effect/Stdio"
import { CliFailure, configError } from "../src/Errors.ts"
import { writeStderrLine } from "../src/TerminalOutput.ts"

/** Plan and apply share one Alchemy lease; a later re-plan cannot slip past the guard. */
export const applyManagedPlan = <A>(
	plan: Alchemist.StackPlan<A>,
	operation: "deploy" | "destroy",
	yes: boolean,
	approval = Prompt.run(
		Prompt.Confirm({
			message:
				operation === "destroy"
					? `Permanently delete "${plan.stack.stage}" and all its data?`
					: `Deploy Checkfu to "${plan.stack.stage}"?`,
			initial: false,
		}),
	).pipe(
		Effect.mapError(() => new CliFailure({ message: "Deployment cancelled.", exitCode: 130 })),
	),
) =>
	Effect.gen(function* () {
		const summary = plan.summary
		if (operation === "deploy" && summary.replace + summary.delete + summary.orphaned > 0) {
			const affected = plan.resources
				.filter(
					({ action }) => action === "replace" || action === "delete" || action === "orphaned",
				)
				.map(({ action, fqn }) => `${action} ${fqn}`)
			return yield* configError(
				`Update refused: this plan would delete or replace existing infrastructure (${affected.join(", ") || "orphaned resources"}). No application changes were applied. Review the server migration before updating. Use checkfu destroy only when you intend to delete the deployment and its data.`,
			)
		}
		yield* writeStderrLine(
			`Plan: ${summary.create} create, ${summary.update} update, ${summary.replace} replace, ${summary.delete} delete, ${summary.noop} unchanged.`,
		)
		if (!yes && Alchemist.hasChanges(plan) && !(yield* approval)) {
			return yield* new CliFailure({
				message: "Deployment cancelled. Nothing was applied.",
				exitCode: 1,
			})
		}
		return yield* Alchemist.apply(plan)
	})

const flags = {
	stage: Flag.String("stage"),
	profile: Flag.String("profile").pipe(Flag.withDefault("default")),
	envFile: Flag.String("env-file").pipe(Flag.optional),
	yes: Flag.Boolean("yes").pipe(Flag.withDefault(false)),
}

const operation = (name: "deploy" | "destroy") =>
	Command.make(name, flags, (input) =>
		Effect.gen(function* () {
			const stdio = yield* Stdio.Stdio
			if (!input.yes && !(yield* stdio.stdinIsTerminal)) {
				return yield* configError(
					`Run checkfu ${name} --stage ${input.stage} --yes to approve a non-interactive deployment operation.`,
				)
			}
			yield* writeStderrLine(`Planning ${name} for "${input.stage}"…`)
			const stack = yield* Alchemist.importStack("alchemy.run.ts")
			const plan = yield* Alchemist.plan({
				stack,
				operation: name,
				stage: input.stage,
				profile: input.profile,
				...Option.match(input.envFile, { onNone: () => ({}), onSome: (envFile) => ({ envFile }) }),
				updateStateStore: true,
			})
			return yield* applyManagedPlan(plan, name, input.yes)
		}).pipe(
			Alchemist.onEvent((event) =>
				event.type === "apply.resource.status"
					? writeStderrLine(`${event.status}: ${event.fqn}`).pipe(Effect.ignore)
					: Effect.void,
			),
		),
	)

if (import.meta.main) {
	runMain(
		Command.run(
			Command.make("checkfu-server").pipe(
				Command.withSubcommands([operation("deploy"), operation("destroy")]),
			),
			{ version: "1" },
		).pipe(Effect.scoped, Effect.provide(Alchemist.layer())),
	)
}
