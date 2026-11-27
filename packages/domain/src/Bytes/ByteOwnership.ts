import * as Schema from "effect/Schema"

export const OwnerMarkFields = {
	purged: Schema.Boolean,
	staged: Schema.Int,
	released: Schema.Int,
}
export const OwnerMarks = Schema.Struct(OwnerMarkFields)
export type OwnerMarks = typeof OwnerMarks.Type

export const initialOwnerMarks: OwnerMarks = { purged: false, staged: 0, released: 0 }

export const OwnerOperation = Schema.Literals(["stage", "check", "release", "purge"])
export const OwnerAction = Schema.Literals([
	"permit",
	"stale",
	"purged",
	"stage",
	"keep",
	"release",
	"removeThenRelease",
	"markThenRemove",
	"removeAgain",
])
export type OwnerAction = typeof OwnerAction.Type

export const ownerTransition = (
	marks: OwnerMarks,
	operation: typeof OwnerOperation.Type,
	reservation: number | null,
):
	| { readonly action: Exclude<OwnerAction, "stale">; readonly marks: OwnerMarks }
	| { readonly action: "stale"; readonly reservation: number; readonly marks: OwnerMarks } => {
	if (operation === "purge") {
		return marks.purged
			? { action: "removeAgain", marks }
			: { action: "markThenRemove", marks: { ...marks, purged: true } }
	}
	if (operation === "release") {
		if (marks.purged || reservation === null || reservation <= marks.released) {
			return { action: "keep", marks }
		}
		return {
			action: marks.staged <= reservation ? "removeThenRelease" : "release",
			marks: { ...marks, released: reservation },
		}
	}
	if (marks.purged) {
		return { action: "purged", marks }
	}
	if (reservation === null) {
		return { action: "permit", marks }
	}
	if (reservation <= marks.released || reservation < marks.staged) {
		return { action: "stale", reservation, marks }
	}
	return operation === "stage" && reservation > marks.staged
		? { action: "stage", marks: { ...marks, staged: reservation } }
		: { action: "permit", marks }
}
