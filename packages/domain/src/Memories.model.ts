import * as Domain from "@alchemy.run/domain"
import { DeleteMemoryDecision } from "./Memory/DeleteMemory.decision.ts"
import { Memory } from "./Memory/Memory.aggregate.ts"
import { MemoryIndex } from "./Memory/MemoryIndex.view.ts"
import { MemoryStore } from "./Memory/MemoryStore.aggregate.ts"
import { MemoryStoreView } from "./Memory/MemoryStoreView.view.ts"
import { MemoryView } from "./Memory/MemoryView.view.ts"
import { WriteMemoryDecision } from "./Memory/WriteMemory.decision.ts"

export class Memories extends Domain.Model("Memories", {
	aggregates: [MemoryStore, Memory],
	decisions: [WriteMemoryDecision, DeleteMemoryDecision],
	views: [MemoryStoreView, MemoryView, MemoryIndex],
	invariants: {
		AStoreCountsItsPresentMemories: (m) =>
			m.MemoryStore.every(
				(store) =>
					store.state.status === "" ||
					store.state.status === "deleted" ||
					store.state.memory_count ===
						m.Memory.filter(
							(memory) =>
								memory.state.status === "present" && memory.state.memory_store_id === store.id,
						).length,
			),
		MemoryViewsMatchMemories: (m) =>
			[
				m.Memory.every((memory) => {
					const view = m.MemoryView.find((v) => v.id === memory.id)
					if (memory.state.status !== "present") {
						return view === undefined
					}
					if (view === undefined) {
						return false
					}
					return [
						view.state.memory_store_id === memory.state.memory_store_id,
						view.state.path === memory.state.path,
						view.state.content_sha256 === memory.state.content_sha256,
						view.state.version === memory.state.version,
					].every((ok) => ok)
				}),
				m.MemoryView.every((v) =>
					m.Memory.some((memory) =>
						[memory.id === v.id, memory.state.status === "present"].every((ok) => ok),
					),
				),
			].every((ok) => ok),
		TheIndexListsEachStoresPresentMemories: (m) =>
			[
				m.MemoryIndex.every((index) =>
					index.state.entries.every((entry) =>
						m.Memory.some((memory) =>
							[
								memory.id === entry.id,
								memory.state.status === "present",
								memory.state.memory_store_id === index.id,
								memory.state.path === entry.path,
								memory.state.content_sha256 === entry.content_sha256,
							].every((ok) => ok),
						),
					),
				),
				m.Memory.every(
					(memory) =>
						memory.state.status !== "present" ||
						m.MemoryIndex.some(
							(index) =>
								index.id === memory.state.memory_store_id &&
								index.state.entries.some((entry) => entry.id === memory.id),
						),
				),
			].every((ok) => ok),
		MemoryStoreViewsMatchStores: (m) =>
			[
				m.MemoryStore.every((store) => {
					const view = m.MemoryStoreView.find((v) => v.id === store.id)
					if (store.state.status === "" || store.state.status === "deleted") {
						return view === undefined
					}
					if (view === undefined) {
						return false
					}
					return [
						view.state.name === store.state.name,
						view.state.description === store.state.description,
						!!view.state.archived_at === (store.state.status === "archived"),
					].every((ok) => ok)
				}),
				m.MemoryStoreView.every((v) =>
					m.MemoryStore.some((store) =>
						[store.id === v.id, store.state.status !== "", store.state.status !== "deleted"].every(
							(ok) => ok,
						),
					),
				),
			].every((ok) => ok),
	},
	relations: {
		APresentMemoryIsInAStoreThatWasCreated: Domain.Relation({
			over: { memory: Memory, store: MemoryStore },
			holds: ({ memory, store }) =>
				[
					memory.state.status !== "present",
					memory.state.memory_store_id !== store.id,
					store.state.status !== "",
				].some((ok) => ok),
		}),
	},
	sometimes: {
		AStoreHoldsAMemory: (m) => m.MemoryStore.some((store) => store.state.memory_count >= 1),
		AMemoryIsDeleted: (m) => m.Memory.some((memory) => memory.state.status === "deleted"),
		AStoreIsArchived: (m) => m.MemoryStore.some((store) => store.state.status === "archived"),
	},
}) {}

export class MemoriesApi extends Domain.Api("MemoriesApi", {
	model: Memories,
	commands: [
		"CreateMemoryStore",
		"UpdateMemoryStore",
		"ArchiveMemoryStore",
		"DeleteMemoryStore",
		"WriteMemory",
		"DeleteMemory",
	],
	views: ["MemoryStoreView", "MemoryView", "MemoryIndex"],
}) {}
