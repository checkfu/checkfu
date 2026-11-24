import * as Model from "@alchemy.run/domain/Model"
import { CheckfuDomainApi } from "@checkfu/domain/Checkfu.model"
import type { ListingKind, ListingOrder } from "@checkfu/domain/Listing/ListingStore"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"

export interface ListQuery {
	readonly after?: number
	readonly limit?: number
	readonly order?: ListingOrder
	readonly include_archived?: boolean
	readonly agent_id?: string
}

export const makeLister = Effect.gen(function* () {
	const internals = yield* Model.Internals
	return <A extends { readonly archived_at: unknown }, E>(
		kind: ListingKind,
		query: ListQuery,
		read: (id: string) => Effect.Effect<Option.Option<A | null>, E>,
	) =>
		Effect.gen(function* () {
			const include_archived = query.include_archived ?? false
			const domain = yield* CheckfuDomainApi.clientInProcess
			const page = yield* domain.ListResources(
				{ kind, include_archived, agent_id: query.agent_id ?? null, order: query.order ?? "asc" },
				{
					take: query.limit ?? 50,
					...(query.after === undefined ? {} : { after: String(query.after) }),
				},
			)
			const found = yield* Effect.forEach(page.entries, (entry) => read(entry.id), {
				concurrency: "unbounded",
			})
			return {
				data: found.flatMap((result) => {
					const resource = Option.getOrNull(result)
					return resource === null || (!include_archived && resource.archived_at !== null)
						? []
						: [resource]
				}),
				has_more: page.cursor !== null,
				next_cursor: page.cursor === null ? null : Number(page.cursor),
			}
		}).pipe(Effect.scoped, Effect.provideService(Model.Internals, internals))
})
