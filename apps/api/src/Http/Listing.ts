import * as Model from "@alchemy.run/domain/Model"
import { CheckfuDomainApi } from "@checkfu/domain/Checkfu.model"
import type { ListingKind, ListingOrder } from "@checkfu/domain/Listing/ListingStore"
import { ERRORS } from "@checkfu/sdk/Api"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"

export interface ListQuery {
	readonly after?: string
	readonly limit?: number
	readonly order?: ListingOrder
	readonly include_archived?: boolean
	readonly agent_id?: string
}

const isNotFound = Schema.is(ERRORS[404])

export const makeLister = Effect.gen(function* () {
	const internals = yield* Model.Internals
	const scope = yield* Scope.Scope
	const client = yield* Effect.cached(
		CheckfuDomainApi.clientInProcess.pipe(
			Scope.provide(scope),
			Effect.provideService(Model.Internals, internals),
		),
	)
	return <A extends { readonly archived_at: unknown }, E, R>(
		kind: ListingKind,
		query: ListQuery,
		retrieve: (id: string) => Effect.Effect<A, E, R>,
	) =>
		Effect.gen(function* () {
			const include_archived = query.include_archived ?? false
			const domain = yield* client
			const page = yield* domain.ListResources(
				{ kind, include_archived, agent_id: query.agent_id ?? null, order: query.order ?? "asc" },
				{
					take: query.limit ?? 50,
					...(query.after === undefined ? {} : { after: query.after }),
				},
			)
			const found = yield* Effect.forEach(
				page.entries,
				(entry) => retrieve(entry.id).pipe(Effect.catchIf(isNotFound, () => Effect.succeed(null))),
				{ concurrency: "unbounded" },
			)
			return {
				data: found.filter(
					(resource): resource is A =>
						resource !== null && (include_archived || resource.archived_at === null),
				),
				has_more: page.cursor !== null,
				next_cursor: page.cursor,
			}
		})
})
