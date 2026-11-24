import type * as Query from "@alchemy.run/domain/Query"
import type { RuntimeContext } from "alchemy/RuntimeContext"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

export const ListingKind = Schema.Literals(["agent", "environment", "session"])
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
	readonly agent_id: string | null
	readonly status: ListingStatus
}

export interface ListingFilter {
	readonly kind: ListingKind
	readonly include_archived: boolean
	readonly agent_id: string | null
	readonly order: ListingOrder
}

export const ListingEntry = Schema.Struct({ id: Schema.String, position: Schema.Int })
export type ListingEntry = typeof ListingEntry.Type

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
		const rows = new Map<string, ListingChange & { readonly position: number }>()
		let last = 0
		return ListingStore.of({
			record: (changes) =>
				Effect.sync(() => {
					for (const change of changes) {
						const key = `${change.kind}/${change.id}`
						const row = rows.get(key)
						if (row === undefined) {
							last += 1
							rows.set(key, { ...change, position: last })
						} else {
							rows.set(key, {
								...row,
								status: change.status > row.status ? change.status : row.status,
							})
						}
					}
				}),
			page: (filter, { after, take }) =>
				Effect.sync(() => {
					const cursor = after === undefined ? undefined : Number(after)
					const matching = [...rows.values()]
						.filter(
							(row) =>
								row.kind === filter.kind &&
								row.status <= (filter.include_archived ? ARCHIVED : LISTED) &&
								(filter.agent_id === null || row.agent_id === filter.agent_id) &&
								(cursor === undefined ||
									(filter.order === "asc" ? row.position > cursor : row.position < cursor)),
						)
						.sort((a, b) =>
							filter.order === "asc" ? a.position - b.position : b.position - a.position,
						)
					const entries = matching.slice(0, take).map(({ id, position }) => ({ id, position }))
					return {
						entries,
						cursor: matching.length > take ? String(entries.at(-1)?.position) : null,
					}
				}),
		})
	})
}
