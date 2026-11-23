import * as Domain from "@alchemy.run/domain"
import { versionedSnapshot } from "@checkfu/snapshots/VersionedSnapshot"
import * as Schema from "effect/Schema"
import { ArchiveMemoryStore, MemoryStoreArchived } from "./ArchiveMemoryStore.command.ts"
import {
	CreateMemoryStore,
	MemoryStoreAlreadyExists,
	MemoryStoreCreated,
} from "./CreateMemoryStore.command.ts"
import { MemoryRemoved } from "./DeleteMemory.command.ts"
import { DeleteMemoryStore, MemoryStoreDeleted } from "./DeleteMemoryStore.command.ts"
import { MemoryStoreId } from "./MemoryStore.id.ts"
import { MemoryStoreArchivedError } from "./MemoryStoreArchived.rejection.ts"
import { MemoryStoreNotFound } from "./MemoryStoreNotFound.rejection.ts"
import { MAX_MEMORIES_PER_STORE, NonNegativeInt } from "./MemoryTypes.ts"
import { MemoryStoreUpdated, UpdateMemoryStore } from "./UpdateMemoryStore.command.ts"
import { MemoryAdded } from "./WriteMemory.command.ts"

export const MemoryStoreState = Schema.Struct({
	status: Schema.String,
	name: Schema.String,
	description: Schema.String,
	memory_count: NonNegativeInt,
})
export type MemoryStoreState = typeof MemoryStoreState.Type

export const MEMORY_STORE_STATE_SCHEMA_VERSION = 1 as const

export const MemoryStoreStateSnapshot = versionedSnapshot({
	current: MEMORY_STORE_STATE_SCHEMA_VERSION,
	schema: MemoryStoreState,
})

export class MemoryStore extends Domain.Aggregate("MemoryStore", {
	id: MemoryStoreId,
	state: MemoryStoreStateSnapshot,
	initial: {
		status: "",
		name: "",
		description: "",
		memory_count: 0,
	},
	commands: [CreateMemoryStore, UpdateMemoryStore, ArchiveMemoryStore, DeleteMemoryStore],
	events: [MemoryAdded, MemoryRemoved],
	keyOf: (cmd) => cmd.memory_store_id,
	invariants: {
		StatusIsKnown: (s) =>
			[
				s.status === "",
				s.status === "active",
				s.status === "archived",
				s.status === "deleted",
			].some((ok) => ok),
		NamedExactlyWhenCreated: (s) =>
			[
				[s.status === "", s.name === "", s.description === "", s.memory_count === 0].every(
					(ok) => ok,
				),
				[s.status !== "", s.name !== ""].every((ok) => ok),
			].some((ok) => ok),
		HoldsNoMoreThanItsLimit: (s) =>
			[s.memory_count >= 0, s.memory_count <= MAX_MEMORIES_PER_STORE].every((ok) => ok),
	},
	transitions: {
		CreatedStoreNeverReturnsToUninitialized: ({ before, after }) =>
			[before.status === "", after.status !== ""].some((ok) => ok),
		ArchivedStoreNeverReactivates: ({ before, after }) =>
			[before.status !== "archived", after.status === "archived", after.status === "deleted"].some(
				(ok) => ok,
			),
		DeletedStoreStaysDeleted: ({ before, after }) =>
			[before.status !== "deleted", after.status === "deleted"].some((ok) => ok),
		OnlyAnActiveStoreChangesWhatItHolds: ({ before, after }) =>
			[
				before.status === "active",
				[
					after.name === before.name,
					after.description === before.description,
					after.memory_count === before.memory_count,
				].every((ok) => ok),
				[before.status === "", after.status === "active", after.memory_count === 0].every(
					(ok) => ok,
				),
			].some((ok) => ok),
		CountMovesByAtMostOne: ({ before, after }) =>
			[
				after.memory_count === before.memory_count,
				after.memory_count === before.memory_count + 1,
				after.memory_count === before.memory_count - 1,
			].some((ok) => ok),
		UpdateKeepsWhatItDoesNotName: ({ before, after, command }) => {
			if (command._tag !== "UpdateMemoryStore") {
				return true
			}
			return [
				after.name === (command.changes.name === undefined ? before.name : command.changes.name),
				after.description ===
					(command.changes.description === undefined
						? before.description
						: command.changes.description),
				after.memory_count === before.memory_count,
			].every((ok) => ok)
		},
	},
	decide: {
		CreateMemoryStore: (state, cmd, ctx) => {
			if (state.status !== "") {
				return new MemoryStoreAlreadyExists({ memory_store_id: ctx.id })
			}
			return [new MemoryStoreCreated({ name: cmd.name, description: cmd.description })]
		},
		UpdateMemoryStore: (state, cmd, ctx) => {
			if ([state.status === "", state.status === "deleted"].some((gone) => gone)) {
				return new MemoryStoreNotFound({ memory_store_id: ctx.id })
			}
			if (state.status !== "active") {
				return new MemoryStoreArchivedError({ memory_store_id: ctx.id })
			}
			return [
				new MemoryStoreUpdated({
					name: cmd.changes.name === undefined ? state.name : cmd.changes.name,
					description:
						cmd.changes.description === undefined ? state.description : cmd.changes.description,
				}),
			]
		},
		ArchiveMemoryStore: (state, _cmd, ctx) => {
			if ([state.status === "", state.status === "deleted"].some((gone) => gone)) {
				return new MemoryStoreNotFound({ memory_store_id: ctx.id })
			}
			if (state.status === "archived") {
				return []
			}
			return [new MemoryStoreArchived()]
		},
		DeleteMemoryStore: (state, _cmd, ctx) => {
			if ([state.status === "", state.status === "deleted"].some((gone) => gone)) {
				return new MemoryStoreNotFound({ memory_store_id: ctx.id })
			}
			return [new MemoryStoreDeleted()]
		},
	},
	evolve: {
		"memory_store.created": (state, e) =>
			state.status === ""
				? { status: "active", name: e.name, description: e.description, memory_count: 0 }
				: state,
		"memory_store.updated": (state, e) =>
			state.status === "active" ? { ...state, name: e.name, description: e.description } : state,
		"memory_store.archived": (state) =>
			state.status === "active" ? { ...state, status: "archived" } : state,
		"memory_store.deleted": (state) =>
			[state.status === "active", state.status === "archived"].some((live) => live)
				? { ...state, status: "deleted" }
				: state,
		"memory_store.memory_added": (state, e) =>
			[
				state.status === "active",
				e.memory_count === state.memory_count + 1,
				e.memory_count <= MAX_MEMORIES_PER_STORE,
			].every((ok) => ok)
				? { ...state, memory_count: e.memory_count }
				: state,
		"memory_store.memory_removed": (state, e) =>
			[state.status === "active", e.memory_count === state.memory_count - 1].every((ok) => ok)
				? { ...state, memory_count: e.memory_count }
				: state,
	},
}) {}
