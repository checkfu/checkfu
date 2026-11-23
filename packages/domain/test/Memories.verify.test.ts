import { Story } from "@alchemy.run/domain/Story"
import * as Verify from "@alchemy.run/domain/Verify"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { Memories, MemoriesApi } from "../src/Memories.model.ts"

const story = Story.make(Memories)

const STANDING = {
	"MemoryStore.StatusIsKnown": "proved",
	"MemoryStore.NamedExactlyWhenCreated": "proved",
	"MemoryStore.HoldsNoMoreThanItsLimit": "proved",
	"MemoryStore.CreatedStoreNeverReturnsToUninitialized": "proved",
	"MemoryStore.ArchivedStoreNeverReactivates": "proved",
	"MemoryStore.DeletedStoreStaysDeleted": "proved",
	"MemoryStore.OnlyAnActiveStoreChangesWhatItHolds": "proved",
	"MemoryStore.CountMovesByAtMostOne": "proved",
	"MemoryStore.UpdateKeepsWhatItDoesNotName": "proved",
	"Memory.StatusIsKnown": "proved",
	"Memory.PlacedExactlyWhenWritten": "proved",
	"Memory.AMemoryNeverLeavesItsPlace": "proved",
	"Memory.VersionGrowsByOneOrNotAtAll": "proved",
	"WriteMemory.OnlyAnActiveStoreIsWritten": "proved",
	"WriteMemory.AWriteLeavesTheMemoryPresentWithItsContent": "proved",
	"WriteMemory.ANewMemoryCountsOnceAndWithinTheLimit": "proved",
	"WriteMemory.AnAbsentPreconditionNeverOverwrites": "proved",
	"DeleteMemory.ADeleteRemovesOnePresentMemory": "proved",
	"Memories.APresentMemoryIsInAStoreThatWasCreated": "proved",
	"Memories.AStoreCountsItsPresentMemories": "checked",
	"Memories.MemoryViewsMatchMemories": "checked",
	"Memories.TheIndexListsEachStoresPresentMemories": "checked",
	"Memories.MemoryStoreViewsMatchStores": "checked",
	"Memories.AStoreHoldsAMemory": "reached",
	"Memories.AMemoryIsDeleted": "reached",
	"Memories.AStoreIsArchived": "reached",
} as const

const PROVED = Object.entries(STANDING)
	.filter(([, standing]) => standing === "proved")
	.map(([name]) => name)

describe("Memories Z3 formal verification", () => {
	// Deleting a memory takes three commands (create the store, write, delete), so the
	// search runs one command deeper than the default and leaves fault injection out.
	it.live(
		"proves every memory store, memory and memory decision rule in Z3",
		() =>
			Effect.gen(function* () {
				const report = yield* Verify.model(Memories, {
					apis: [MemoriesApi],
					story,
					instances: 1,
					depth: 3,
					faults: { redeliver: false, reorder: false, rerun: false },
					walks: { count: 50 },
					lock: "./Memories.verify.lock.json",
					require: { proved: PROVED },
				})
				expect(Object.fromEntries(report.rules.map((rule) => [rule.name, rule.standing]))).toEqual(
					STANDING,
				)
				expect(report.undone).toEqual([])
				expect(report.explored.aside).toEqual([])
				expect(report.explored.truncated).toBe(false)
				expect(report.explored.complete).toBe(3)
				expect(report.explored.disagreements).toEqual([])
				expect(report.explored.agreement.compared).toBeGreaterThan(0)
			}).pipe(Effect.provide(NodeServices.layer)),
		240_000,
	)
})
