import type { JsonMemory } from "@checkfu/sdk/client"

export interface MemoryEdit {
	readonly base: JsonMemory
	readonly text: string
}

export const rebaseOnto = (memory: JsonMemory, edit: MemoryEdit): MemoryEdit => ({
	base: memory,
	text: edit.text,
})

export const editorOf = (memory: JsonMemory, edit: MemoryEdit | undefined) => {
	const base = edit?.base ?? memory
	const overtaken = edit !== undefined && memory.version > edit.base.version
	return {
		text: edit?.text ?? memory.content,
		base,
		overtaken,
		canSave: edit !== undefined && !overtaken && edit.text !== base.content,
	}
}
