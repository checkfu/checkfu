import { expect, it } from "@effect/vitest"
import * as Alchemy from "alchemy"
import * as Alchemist from "alchemy/Alchemist"
import * as Provider from "alchemy/Provider"
import { isResolved } from "alchemy/Diff"
import { Resource } from "alchemy/Resource"
import * as Effect from "effect/Effect"
import { applyManagedPlan } from "../scripts/Deployment.ts"

type DataStore = Resource<
	"Checkfu.Test.DataStore",
	{ revision: string; generation: string },
	{ id: string; revision: string; generation: string }
>
const DataStore = Resource<DataStore>("Checkfu.Test.DataStore")

it.live(
	"uses real Alchemy plans to preserve data on updates, refuse replacements/deletions even with --yes, and allow explicit destroy and redeploy",
	() =>
		Effect.gen(function* () {
			const data = new Map<string, string>()
			let creations = 0
			let deletions = 0
			const provider = Provider.succeed(DataStore, {
				stables: ["id"],
				diff: ({ olds, news }) =>
					Effect.sync(() => {
						if (!isResolved(news)) {
							return undefined
						}
						return olds?.generation !== news.generation ? { action: "replace" as const } : undefined
					}),
				read: ({ output }) => Effect.succeed(output),
				reconcile: ({ news, output }) =>
					Effect.sync(() => {
						const id = output?.id ?? `store-${++creations}`
						data.set(id, data.get(id) ?? "user-owned notes")
						return { id, revision: news.revision, generation: news.generation }
					}),
				delete: ({ output }) =>
					Effect.sync(() => {
						deletions++
						if (output) {
							data.delete(output.id)
						}
					}),
			})
			const state = Alchemy.inMemoryState()
			const stack = (revision: string, generation = "1", includeData = true) =>
				Alchemy.Stack(
					"CheckfuCliQualification",
					{ state, providers: provider },
					Effect.gen(function* () {
						if (includeData) {
							yield* DataStore("Data", { revision, generation })
						}
						return {}
					}),
				)
			const plan = (
				revision: string,
				generation = "1",
				includeData = true,
				operation: "deploy" | "destroy" = "deploy",
			) =>
				Alchemist.plan({
					stack: stack(revision, generation, includeData),
					operation,
					stage: "staging",
				})
			const first = yield* plan("first")
			expect(first.summary.create).toBe(1)
			yield* applyManagedPlan(first, "deploy", true)
			const identity = [...data.keys()][0]
			expect(identity).toBe("store-1")
			data.set("store-1", "notes created after the first deployment")
			const update = yield* plan("second")
			expect(update.summary.update).toBe(1)
			yield* applyManagedPlan(update, "deploy", true)
			expect([...data]).toEqual([[identity, "notes created after the first deployment"]])
			const repeated = yield* plan("second")
			expect(repeated.summary.noop).toBe(1)
			yield* applyManagedPlan(repeated, "deploy", true)
			for (const destructive of [yield* plan("third", "2"), yield* plan("third", "1", false)]) {
				expect(destructive.summary.replace + destructive.summary.delete).toBe(1)
				const refused = yield* Effect.result(applyManagedPlan(destructive, "deploy", true))
				expect(refused._tag).toBe("Failure")
				if (refused._tag === "Failure") {
					expect(refused.failure.message).toContain("Update refused")
				}
				expect(data.get("store-1")).toBe("notes created after the first deployment")
				expect([creations, deletions]).toEqual([1, 0])
			}
			const declined = yield* Effect.flip(
				applyManagedPlan(yield* plan("third"), "deploy", false, Effect.succeed(false)),
			)
			expect(declined.message).toContain("cancelled")
			expect([creations, deletions]).toEqual([1, 0])
			const destroy = yield* plan("second", "1", true, "destroy")
			expect(destroy.summary.delete).toBe(1)
			yield* applyManagedPlan(destroy, "destroy", true)
			expect(data.size).toBe(0)
			expect(deletions).toBe(1)
			yield* applyManagedPlan(yield* plan("fresh"), "deploy", true)
			expect([...data.keys()]).toEqual(["store-2"])
		}).pipe(Effect.scoped, Effect.provide(Alchemist.layer())),
)
