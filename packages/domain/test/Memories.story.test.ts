import * as Domain from "@alchemy.run/domain"
import { Story } from "@alchemy.run/domain/Story"
import { describe, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import {
	ArchiveMemoryStore,
	MemoryStoreArchived,
} from "../src/Memory/ArchiveMemoryStore.command.ts"
import {
	CreateMemoryStore,
	MemoryStoreAlreadyExists,
	MemoryStoreCreated,
} from "../src/Memory/CreateMemoryStore.command.ts"
import { DeleteMemory, MemoryDeleted, MemoryRemoved } from "../src/Memory/DeleteMemory.command.ts"
import { DeleteMemoryStore, MemoryStoreDeleted } from "../src/Memory/DeleteMemoryStore.command.ts"
import { Memory } from "../src/Memory/Memory.aggregate.ts"
import { MemoryId } from "../src/Memory/Memory.id.ts"
import { MemoryIndex } from "../src/Memory/MemoryIndex.view.ts"
import { MemoryStore } from "../src/Memory/MemoryStore.aggregate.ts"
import { MemoryStoreId } from "../src/Memory/MemoryStore.id.ts"
import { MemoryStoreArchivedError } from "../src/Memory/MemoryStoreArchived.rejection.ts"
import { MemoryStoreNotFound } from "../src/Memory/MemoryStoreNotFound.rejection.ts"
import { MemoryStoreView } from "../src/Memory/MemoryStoreView.view.ts"
import { MAX_MEMORIES_PER_STORE } from "../src/Memory/MemoryTypes.ts"
import { MemoryView } from "../src/Memory/MemoryView.view.ts"
import { MemoryStoreUpdated, UpdateMemoryStore } from "../src/Memory/UpdateMemoryStore.command.ts"
import {
	MemoryAdded,
	MemoryLayoutChanged,
	MemoryAlreadyExists,
	MemoryNotFound,
	MemoryPlacedElsewhere,
	MemoryPreconditionFailed,
	MemoryStoreFull,
	MemoryWritten,
	WriteMemory,
} from "../src/Memory/WriteMemory.command.ts"
import { Memories } from "../src/Memories.model.ts"

const story = Story.make(Memories)

const t0 = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z")
const t1 = DateTime.makeUnsafe("2026-01-01T00:01:00.000Z")
const t2 = DateTime.makeUnsafe("2026-01-01T00:02:00.000Z")

const sha = (letter: string) => letter.repeat(64)

const store = MemoryStore.ref(MemoryStoreId.make("memstore_prefs"))
const notes = Memory.ref(MemoryId.make("mem_notes"))
const todo = Memory.ref(MemoryId.make("mem_todo"))

const write = (
	memory: typeof notes,
	path: string,
	content: string,
	hash: string,
	precondition: WriteMemory["precondition"] = { type: "none" },
	session_id: string | null = null,
	layout_version = 0,
) =>
	new WriteMemory({
		memory_id: memory.id,
		memory_store_id: store.id,
		path,
		content,
		content_sha256: hash,
		content_size_bytes: content.length,
		precondition,
		layout_version,
		session_id,
	})

const written = (
	path: string,
	content: string,
	hash: string,
	version: number,
	operation: "created" | "modified",
	session_id: string | null = null,
) =>
	new MemoryWritten({
		memory_store_id: store.id,
		path,
		content,
		content_sha256: hash,
		content_size_bytes: content.length,
		version,
		operation,
		session_id,
	})

const created = new MemoryStoreCreated({ name: "User Preferences", description: "Per user." })

describe("Memories", () => {
	it.effect("is well defined", () =>
		Effect.scoped(Layer.build(Memories.layer(Layer.empty))).pipe(Effect.provide(Domain.InMemory)),
	)

	it.effect("creates, renames, archives and deletes a store, and refuses what cannot be", () =>
		story(
			Story.clock(t0),
			Story.when(
				new UpdateMemoryStore({ memory_store_id: store.id, changes: { name: "Too early" } }),
			),
			Story.rejected(new MemoryStoreNotFound({ memory_store_id: store.id })),
			Story.when(new ArchiveMemoryStore({ memory_store_id: store.id })),
			Story.rejected(new MemoryStoreNotFound({ memory_store_id: store.id })),
			Story.when(new DeleteMemoryStore({ memory_store_id: store.id })),
			Story.rejected(new MemoryStoreNotFound({ memory_store_id: store.id })),

			Story.when(
				new CreateMemoryStore({
					memory_store_id: store.id,
					name: "User Preferences",
					description: "Per user.",
				}),
			),
			Story.then(store, created),
			Story.when(
				new CreateMemoryStore({ memory_store_id: store.id, name: "Again", description: "" }),
			),
			Story.rejected(new MemoryStoreAlreadyExists({ memory_store_id: store.id })),
			Story.view(MemoryStoreView, store, {
				id: store.id,
				type: "memory_store",
				name: "User Preferences",
				description: "Per user.",
				created_at: t0,
				updated_at: t0,
				archived_at: null,
			}),

			Story.clock(t1),
			Story.when(
				new UpdateMemoryStore({ memory_store_id: store.id, changes: { name: "Preferences" } }),
			),
			Story.then(store, new MemoryStoreUpdated({ name: "Preferences", description: "Per user." })),
			Story.when(
				new UpdateMemoryStore({ memory_store_id: store.id, changes: { description: "" } }),
			),
			Story.then(store, new MemoryStoreUpdated({ name: "Preferences", description: "" })),
			Story.view(MemoryStoreView, store, { name: "Preferences", description: "", updated_at: t1 }),

			Story.clock(t2),
			Story.when(new ArchiveMemoryStore({ memory_store_id: store.id })),
			Story.then(store, new MemoryStoreArchived()),
			Story.when(new ArchiveMemoryStore({ memory_store_id: store.id })),
			Story.then(store),
			Story.view(MemoryStoreView, store, { archived_at: t2 }),
			Story.when(
				new UpdateMemoryStore({ memory_store_id: store.id, changes: { name: "Read-only now" } }),
			),
			Story.rejected(new MemoryStoreArchivedError({ memory_store_id: store.id })),

			Story.when(new DeleteMemoryStore({ memory_store_id: store.id })),
			Story.then(store, new MemoryStoreDeleted()),
			Story.view(MemoryStoreView, store, Story.none),
			Story.when(new DeleteMemoryStore({ memory_store_id: store.id })),
			Story.rejected(new MemoryStoreNotFound({ memory_store_id: store.id })),
			Story.when(new ArchiveMemoryStore({ memory_store_id: store.id })),
			Story.rejected(new MemoryStoreNotFound({ memory_store_id: store.id })),
		),
	)

	it.effect("writes a memory under each precondition and counts it in its store once", () =>
		story(
			Story.clock(t0),
			Story.when(write(notes, "/notes.md", "tabs", sha("a"))),
			Story.rejected(new MemoryStoreNotFound({ memory_store_id: store.id })),

			Story.given(store, created),
			Story.when(
				write(notes, "/notes.md", "tabs", sha("a"), {
					type: "content_sha256",
					content_sha256: sha("a"),
				}),
			),
			Story.rejected(new MemoryNotFound({ memory_id: notes.id })),

			Story.when(write(notes, "/notes.md", "tabs", sha("a"), { type: "present" })),
			Story.rejected(new MemoryNotFound({ memory_id: notes.id })),

			Story.when(write(notes, "/notes.md", "tabs", sha("a"), { type: "absent" }, "sess_1")),
			Story.then(notes, written("/notes.md", "tabs", sha("a"), 1, "created", "sess_1")),
			Story.then(store, new MemoryAdded({ memory_count: 1 })),
			Story.replied({ version: 1 }),
			Story.view(MemoryView, notes, {
				id: notes.id,
				type: "memory",
				memory_store_id: store.id,
				path: "/notes.md",
				content: "tabs",
				content_sha256: sha("a"),
				content_size_bytes: 4,
				version: 1,
				created_at: t0,
				updated_at: t0,
			}),

			Story.when(write(notes, "/notes.md", "spaces", sha("b"), { type: "absent" })),
			Story.rejected(new MemoryAlreadyExists({ memory_id: notes.id })),
			Story.when(
				write(notes, "/notes.md", "spaces", sha("b"), {
					type: "content_sha256",
					content_sha256: sha("c"),
				}),
			),
			Story.rejected(
				new MemoryPreconditionFailed({ memory_id: notes.id, content_sha256: sha("c") }),
			),
			Story.when(write(notes, "/other.md", "spaces", sha("b"))),
			Story.rejected(new MemoryPlacedElsewhere({ memory_id: notes.id })),

			// A write of what is already stored changes nothing, whatever it expected to replace.
			Story.when(
				write(notes, "/notes.md", "tabs", sha("a"), {
					type: "content_sha256",
					content_sha256: sha("c"),
				}),
			),
			Story.then(notes),
			Story.then(store),
			Story.replied({ version: 1 }),

			Story.clock(t1),
			Story.when(
				write(notes, "/notes.md", "spaces", sha("b"), {
					type: "content_sha256",
					content_sha256: sha("a"),
				}),
			),
			Story.then(notes, written("/notes.md", "spaces", sha("b"), 2, "modified")),
			Story.then(store),
			Story.replied({ version: 2 }),
			Story.when(write(todo, "/todo.md", "ship", sha("d"), { type: "none" }, null, 1)),
			Story.then(todo, written("/todo.md", "ship", sha("d"), 1, "created")),
			Story.then(store, new MemoryAdded({ memory_count: 2 })),
			Story.when(write(todo, "/todo.md", "shipped", sha("f"), { type: "present" })),
			Story.then(todo, written("/todo.md", "shipped", sha("f"), 2, "modified")),
			Story.then(store),

			Story.state(store, { status: "active", memory_count: 2 }),
			Story.view(MemoryView, notes, {
				content: "spaces",
				version: 2,
				created_at: t0,
				updated_at: t1,
			}),
			Story.view(MemoryIndex, store, {
				entries: [
					{
						id: notes.id,
						path: "/notes.md",
						content_sha256: sha("b"),
						content_size_bytes: 6,
						created_at: t0,
						updated_at: t1,
					},
					{
						id: todo.id,
						path: "/todo.md",
						content_sha256: sha("f"),
						content_size_bytes: 7,
						created_at: t1,
						updated_at: t1,
					},
				],
			}),
		),
	)

	it.effect(
		"deletes a memory, frees its place in the count, and lets the path be written again",
		() =>
			story(
				Story.clock(t0),
				Story.given(store, created, new MemoryAdded({ memory_count: 1 })),
				Story.given(notes, written("/notes.md", "tabs", sha("a"), 1, "created")),

				Story.when(
					new DeleteMemory({
						memory_id: todo.id,
						memory_store_id: store.id,
						expected_content_sha256: null,
						session_id: null,
					}),
				),
				Story.rejected(new MemoryNotFound({ memory_id: todo.id })),
				Story.when(
					new DeleteMemory({
						memory_id: notes.id,
						memory_store_id: store.id,
						expected_content_sha256: sha("b"),
						session_id: null,
					}),
				),
				Story.rejected(
					new MemoryPreconditionFailed({ memory_id: notes.id, content_sha256: sha("b") }),
				),

				Story.when(
					new DeleteMemory({
						memory_id: notes.id,
						memory_store_id: store.id,
						expected_content_sha256: sha("a"),
						session_id: "sess_1",
					}),
				),
				Story.then(
					notes,
					new MemoryDeleted({
						memory_store_id: store.id,
						path: "/notes.md",
						version: 2,
						session_id: "sess_1",
					}),
				),
				Story.then(store, new MemoryRemoved({ memory_count: 0 })),
				Story.view(MemoryView, notes, Story.none),
				Story.view(MemoryIndex, store, { entries: [] }),
				Story.when(
					new DeleteMemory({
						memory_id: notes.id,
						memory_store_id: store.id,
						expected_content_sha256: null,
						session_id: null,
					}),
				),
				Story.rejected(new MemoryNotFound({ memory_id: notes.id })),

				Story.clock(t1),
				Story.when(write(notes, "/notes.md", "again", sha("e"), { type: "absent" }, null, 2)),
				Story.then(notes, written("/notes.md", "again", sha("e"), 3, "created")),
				Story.then(store, new MemoryAdded({ memory_count: 1 })),
				Story.view(MemoryView, notes, { content: "again", version: 3, created_at: t1 }),
			),
	)

	it.effect("refuses a new path checked before another memory was created in the store", () =>
		story(
			Story.clock(t0),
			Story.given(store, created, new MemoryAdded({ memory_count: 1 })),
			Story.given(notes, written("/notes.md", "tabs", sha("a"), 1, "created")),
			Story.when(write(todo, "/todo.md", "ship", sha("d"))),
			Story.rejected(new MemoryLayoutChanged({ memory_store_id: store.id, layout_version: 1 })),
			Story.when(write(todo, "/todo.md", "ship", sha("d"), { type: "none" }, null, 1)),
			Story.then(todo, written("/todo.md", "ship", sha("d"), 1, "created")),
			Story.then(store, new MemoryAdded({ memory_count: 2 })),
			// A memory already there is not a new path, so its store's layout does not matter.
			Story.when(write(notes, "/notes.md", "spaces", sha("b"))),
			Story.then(notes, written("/notes.md", "spaces", sha("b"), 2, "modified")),
			Story.then(store),
		),
	)

	it.effect(
		"refuses a new memory in a full store but still takes changes to the ones it holds",
		() =>
			story(
				Story.clock(t0),
				Story.given(
					store,
					created,
					...Array.from(
						{ length: MAX_MEMORIES_PER_STORE },
						(_, index) => new MemoryAdded({ memory_count: index + 1 }),
					),
				),
				Story.given(notes, written("/notes.md", "tabs", sha("a"), 1, "created")),
				Story.when(write(todo, "/todo.md", "ship", sha("d"))),
				Story.rejected(
					new MemoryStoreFull({ memory_store_id: store.id, memory_count: MAX_MEMORIES_PER_STORE }),
				),
				Story.when(write(notes, "/notes.md", "spaces", sha("b"))),
				Story.then(notes, written("/notes.md", "spaces", sha("b"), 2, "modified")),
				Story.then(store),
			),
	)

	it.effect("makes an archived store read-only and a deleted one unreachable", () =>
		story(
			Story.clock(t0),
			Story.given(store, created, new MemoryAdded({ memory_count: 1 }), new MemoryStoreArchived()),
			Story.given(notes, written("/notes.md", "tabs", sha("a"), 1, "created")),
			Story.when(write(notes, "/notes.md", "spaces", sha("b"))),
			Story.rejected(new MemoryStoreArchivedError({ memory_store_id: store.id })),
			Story.when(
				new DeleteMemory({
					memory_id: notes.id,
					memory_store_id: store.id,
					expected_content_sha256: null,
					session_id: null,
				}),
			),
			Story.rejected(new MemoryStoreArchivedError({ memory_store_id: store.id })),
			Story.view(MemoryView, notes, { content: "tabs" }),

			Story.when(new DeleteMemoryStore({ memory_store_id: store.id })),
			Story.then(store, new MemoryStoreDeleted()),
			Story.when(write(notes, "/notes.md", "spaces", sha("b"))),
			Story.rejected(new MemoryStoreNotFound({ memory_store_id: store.id })),
			Story.when(
				new DeleteMemory({
					memory_id: notes.id,
					memory_store_id: store.id,
					expected_content_sha256: null,
					session_id: null,
				}),
			),
			Story.rejected(new MemoryStoreNotFound({ memory_store_id: store.id })),
		),
	)
})
