import type * as Query from "@alchemy.run/domain/Query"
import type { RuntimeContext } from "alchemy/RuntimeContext"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

export const ListingKind = Schema.Literals([
	"agent",
	"environment",
	"session",
	"memory_store",
	"artifact",
])
export type ListingKind = typeof ListingKind.Type

export const ListingOrder = Schema.Literals(["asc", "desc"])
export type ListingOrder = typeof ListingOrder.Type

export const LISTED = 0
export const ARCHIVED = 1
export const DELETED = 2
export type ListingStatus = typeof LISTED | typeof ARCHIVED | typeof DELETED

export interface ListingChange {
	readonly kind: ListingKind
	readonly id: string
	readonly created_at: number
	readonly agent_id: string | null
	readonly status: ListingStatus
}

export interface ListingFilter {
	readonly kind: ListingKind
	readonly include_archived: boolean
	readonly agent_id: string | null
	readonly order: ListingOrder
}

export const ListingEntry = Schema.Struct({ id: Schema.String, created_at: Schema.Int })
export type ListingEntry = typeof ListingEntry.Type

export interface ListingPosition {
	readonly created_at: number
	readonly id: string
}

export const listingCursor = (row: ListingPosition): string => `${row.created_at}:${row.id}`

export const parseListingCursor = (cursor: string): ListingPosition => {
	const split = cursor.indexOf(":")
	return { created_at: Number(cursor.slice(0, split)), id: cursor.slice(split + 1) }
}

const compareIds = (a: string, b: string): number => {
	let left = 0
	let right = 0
	while (left < a.length && right < b.length) {
		const x = a.codePointAt(left) ?? 0
		const y = b.codePointAt(right) ?? 0
		if (x !== y) {
			return x - y
		}
		left += x > 0xff_ff ? 2 : 1
		right += y > 0xff_ff ? 2 : 1
	}
	return Number(left < a.length) - Number(right < b.length)
}

const compareRows = (a: ListingPosition, b: ListingPosition): number =>
	a.created_at - b.created_at || compareIds(a.id, b.id)

/** @effect-expect-leaking RuntimeContext */
export class ListingStore extends Context.Service<
	ListingStore,
	{
		readonly record: (
			changes: ReadonlyArray<ListingChange>,
		) => Effect.Effect<void, never, RuntimeContext>
		readonly page: (
			filter: ListingFilter,
			page: Query.PageRequest,
		) => Effect.Effect<Query.Page<ListingEntry>, never, RuntimeContext>
	}
>()("Checkfu/ListingStore") {
	static readonly memory = Layer.sync(ListingStore, () => {
		const rows = new Map<string, ListingChange>()
		return ListingStore.of({
			record: (changes) =>
				Effect.sync(() => {
					for (const change of changes) {
						const key = `${change.kind}/${change.id}`
						const row = rows.get(key)
						rows.set(
							key,
							row === undefined
								? change
								: { ...row, status: change.status > row.status ? change.status : row.status },
						)
					}
				}),
			page: (filter, { after, take }) =>
				Effect.sync(() => {
					const cursor = after === undefined ? undefined : parseListingCursor(after)
					const direction = filter.order === "asc" ? 1 : -1
					const matching = [...rows.values()]
						.filter(
							(row) =>
								row.kind === filter.kind &&
								row.status <= (filter.include_archived ? ARCHIVED : LISTED) &&
								(filter.agent_id === null || row.agent_id === filter.agent_id) &&
								(cursor === undefined || compareRows(row, cursor) * direction > 0),
						)
						.sort((a, b) => compareRows(a, b) * direction)
					const page = matching.slice(0, take)
					const last = page.at(-1)
					return {
						entries: page.map(({ id, created_at }) => ({ id, created_at })),
						cursor: matching.length > take && last !== undefined ? listingCursor(last) : null,
					}
				}),
		})
	})
}
