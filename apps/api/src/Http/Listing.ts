import * as Model from "@alchemy.run/domain/Model"
import { ListingEntry, listingCursor } from "@checkfu/domain/Listing/ListingStore"
import type { ListingKind, ListingOrder } from "@checkfu/domain/Listing/ListingStore"
import { ListResources } from "@checkfu/domain/Listing/ListResources.query"
import { ERRORS } from "@checkfu/sdk/Api"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"

export interface ListQuery {
	readonly after?: string
	readonly limit?: number
	readonly order?: ListingOrder
	readonly include_archived?: boolean
	readonly agent_id?: string
}

export const LIST_PAGE_BYTES = 4_000_000

const HYDRATE_CONCURRENCY = 10

const utf8 = new TextEncoder()

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
	return <A extends object, E, R>(
		kind: ListingKind,
		input: ListQuery,
		retrieve: (id: string) => Effect.Effect<A, E, R>,
	) =>
		Effect.gen(function* () {
			const include_archived = input.include_archived ?? false
			const page = yield* Effect.orDie(
				query.run(
					{ kind, include_archived, agent_id: input.agent_id ?? null, order: input.order ?? "asc" },
					{ take: input.limit ?? 50, ...(input.after === undefined ? {} : { after: input.after }) },
				),
			).pipe(Effect.flatMap(decodePage), Effect.orDie)
			const data: Array<A> = []
			let bytes = 0
			let handled: ListingEntry | undefined
			let cut = false
			yield* Stream.fromIterable(page.entries).pipe(
				Stream.mapEffect(
					(entry) =>
						Effect.exit(
							retrieve(entry.id).pipe(Effect.catchIf(isNotFound, () => Effect.succeed(null))),
						).pipe(Effect.map((outcome) => ({ entry, outcome }))),
					{ concurrency: HYDRATE_CONCURRENCY },
				),
				Stream.runForEachWhile(({ entry, outcome }) =>
					Effect.gen(function* () {
						const resource = yield* outcome
						const archived =
							resource !== null && "archived_at" in resource && resource.archived_at !== null
						if (resource !== null && (include_archived || !archived)) {
							const size = utf8.encode(JSON.stringify(resource)).length
							const next = pageBytesWith(bytes, data.length, size)
							if (data.length > 0 && next > LIST_PAGE_BYTES) {
								cut = true
								return false
							}
							bytes = next
							data.push(resource)
						}
						handled = entry
						return true
					}),
				),
			)
			return cut && handled !== undefined
				? { data, has_more: true, next_cursor: listingCursor(handled) }
				: { data, has_more: page.cursor !== null, next_cursor: page.cursor }
		})
})
