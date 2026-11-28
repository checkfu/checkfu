import type { JsonMemory } from "@checkfu/sdk/client"
import { describe, expect, it } from "vitest"
import { editorOf, rebaseOnto } from "../src/memory-edit.ts"

const memory = (version: number, content: string): JsonMemory => ({
	id: "mem_1",
	type: "memory",
	memory_store_id: "memstore_1",
	path: "/a.md",
	content,
	content_sha256: `sha-of-${content}`,
	content_size_bytes: content.length,
	version,
	created_at: "2026-11-24T00:00:00.000Z",
	updated_at: "2026-11-24T00:00:00.000Z",
})

describe("memory editor", () => {
	it("follows the server while nothing is being edited", () => {
		expect(editorOf(memory(2, "Theirs."), undefined)).toMatchObject({
			text: "Theirs.",
			overtaken: false,
			canSave: false,
		})
	})

	it("keeps an edit and the version it started from when a newer version arrives", () => {
		const opened = memory(1, "First.")
		const edit = { base: opened, text: "Mine." }
		expect(editorOf(opened, edit)).toMatchObject({ text: "Mine.", overtaken: false, canSave: true })
		const editor = editorOf(memory(2, "Theirs."), edit)
		expect(editor).toMatchObject({ text: "Mine.", overtaken: true, canSave: false })
		expect(editor.base.content_sha256).toBe("sha-of-First.")
	})

	it("keeps the draft and uses only the version accepted by the editor as the save precondition", () => {
		const latest = memory(2, "Theirs.")
		const draft = rebaseOnto(latest, { base: memory(1, "First."), text: "Mine." })
		const rebased = editorOf(latest, draft)
		expect(rebased).toMatchObject({
			text: "Mine.",
			base: { version: 2, content_sha256: "sha-of-Theirs." },
			overtaken: false,
			canSave: true,
		})
		expect(editorOf(memory(3, "Newer."), draft)).toMatchObject({
			text: "Mine.",
			base: { version: 2 },
			overtaken: true,
			canSave: false,
		})
	})

	it("has nothing to save when the text is back to what it started as", () => {
		const opened = memory(1, "First.")
		expect(editorOf(opened, { base: opened, text: "First." }).canSave).toBe(false)
	})
})
