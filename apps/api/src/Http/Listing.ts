import * as Model from "@alchemy.run/domain/Model"
import { ListingEntry, listingCursor } from "@checkfu/domain/Listing/ListingStore"
import type { ListingKind, ListingOrder } from "@checkfu/domain/Listing/ListingStore"
import { ListResources } from "@checkfu/domain/Listing/ListResources.query"
import { ERRORS } from "@checkfu/sdk/Api"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

export interface ListQuery {
	readonly after?: string
	readonly limit?: number
	readonly order?: ListingOrder
	readonly include_archived?: boolean
	readonly agent_id?: string
}

export const LIST_PAGE_BYTES = 4_000_000

const HYDRATE_BATCH = 10

const utf8 = new TextEncoder()

/** The bytes of a JSON array once it holds one more entry: its brackets, commas and entries. */
export const pageBytesWith = (bytes: number, count: number, size: number): number =>
	(count === 0 ? 2 : bytes + 1) + size

const isNotFound = Schema.is(ERRORS[404])

const decodePage = Schema.decodeUnknownEffect(
	Schema.Struct({ entries: Schema.Array(ListingEntry), cursor: Schema.NullOr(Schema.String) }),
)

export const makeLister = Effect.gen(function* () {
	const query = (yield* Model.Internals).queries.get(ListResources.queryName)
	if (query === undefined) {
		return yield* Effect.die(new Error("ListResources is not hosted by the model."))
	}
	return <A extends { readonly archived_at: unknown }, E, R>(
		kind: ListingKind,
		input: ListQuery,
		retrieve: (id: string) => Effect.Effect<A, E, R>,
	) =>
		Effect.gen(function* () {
			const include_archived = input.include_archived ?? false
			const page = yield* Effect.orDie(
				// @effect-diagnostics-next-line anyUnknownInErrorContext:off
				query.run(
					{ kind, include_archived, agent_id: input.agent_id ?? null, order: input.order ?? "asc" },
					{ take: input.limit ?? 50, ...(input.after === undefined ? {} : { after: input.after }) },
				),
			).pipe(Effect.flatMap(decodePage), Effect.orDie)
			const data: Array<A> = []
			let bytes = 0
			for (let start = 0; start < page.entries.length; start += HYDRATE_BATCH) {
				const batch = page.entries.slice(start, start + HYDRATE_BATCH)
				const found = yield* Effect.forEach(
					batch,
					(entry) =>
						retrieve(entry.id).pipe(Effect.catchIf(isNotFound, () => Effect.succeed(null))),
					{ concurrency: "unbounded" },
				)
				for (const [offset, resource] of found.entries()) {
					if (resource === null || (!include_archived && resource.archived_at !== null)) {
						continue
					}
					const next = pageBytesWith(
						bytes,
						data.length,
						utf8.encode(JSON.stringify(resource)).length,
					)
					const previous = page.entries[start + offset - 1]
					if (data.length > 0 && next > LIST_PAGE_BYTES && previous !== undefined) {
						return { data, has_more: true, next_cursor: listingCursor(previous) }
					}
					bytes = next
					data.push(resource)
				}
			}
			return { data, has_more: page.cursor !== null, next_cursor: page.cursor }
		})
})
