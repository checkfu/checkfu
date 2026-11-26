import * as Model from "@alchemy.run/domain/Model"
import type * as Query from "@alchemy.run/domain/Query"
import { ListingEntry, listingCursor } from "@checkfu/domain/Listing/ListingStore"
import type { ListingFilter, ListingKind, ListingOrder } from "@checkfu/domain/Listing/ListingStore"
import { ListResources } from "@checkfu/domain/Listing/ListResources.query"
import { ListCredentials } from "@checkfu/domain/Vault/ListCredentials.query"
import { ListVaults } from "@checkfu/domain/Vault/ListVaults.query"
import { ERRORS } from "@checkfu/sdk/Api"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"

export interface ListQuery {
	readonly page?: string
	readonly limit?: number
	readonly order?: ListingOrder
	readonly include_archived?: boolean
	readonly agent_id?: string
}

export const listPage = <Item>(data: ReadonlyArray<Item>, cursor: string | number | null) => ({
	data,
	next_page: cursor === null ? null : String(cursor),
})

export const LIST_PAGE_BYTES = 4_000_000

const HYDRATE_CONCURRENCY = 10

const utf8 = new TextEncoder()

export const pageBytesWith = (bytes: number, count: number, size: number): number =>
	(count === 0 ? 2 : bytes + 1) + size

const isNotFound = Schema.is(ERRORS[404])

const decodePage = Schema.decodeUnknownEffect(
	Schema.Struct({ entries: Schema.Array(ListingEntry), cursor: Schema.NullOr(Schema.String) }),
)

type PageOf<RP> = (
	filter: ListingFilter,
	page: Query.PageRequest,
) => Effect.Effect<
	{ readonly entries: ReadonlyArray<ListingEntry>; readonly cursor: string | null },
	never,
	RP
>

type OwnedBy = (resource: unknown, parent: string) => boolean

const ownedByAgent: OwnedBy = (resource, parent) =>
	Predicate.hasProperty(resource, "agent") &&
	Predicate.hasProperty(resource.agent, "id") &&
	resource.agent.id === parent

const ownedByVault: OwnedBy = (resource, parent) =>
	Predicate.hasProperty(resource, "vault_id") && resource.vault_id === parent

const listWith =
	<RP>(pageOf: PageOf<RP>, ownedBy: OwnedBy = ownedByAgent) =>
	<A extends object, E, R>(
		kind: ListingKind,
		input: ListQuery,
		retrieve: (id: string) => Effect.Effect<A, E, R>,
	) =>
		Effect.gen(function* () {
			const include_archived = input.include_archived ?? false
			const page = yield* pageOf(
				{ kind, include_archived, agent_id: input.agent_id ?? null, order: input.order ?? "asc" },
				{ take: input.limit ?? 50, after: input.page },
			)
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
						const owned =
							resource !== null &&
							(input.agent_id === undefined || ownedBy(resource, input.agent_id))
						if (resource !== null && owned && (include_archived || !archived)) {
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
			const cursor = cut && handled !== undefined ? listingCursor(handled) : page.cursor
			return listPage(data, cursor)
		})

export const makeLister = Effect.gen(function* () {
	const query = (yield* Model.Internals).queries.get(ListResources.queryName)
	if (query === undefined) {
		return yield* Effect.die(new Error("ListResources is not hosted by the model."))
	}
	return listWith(({ kind, include_archived, agent_id, order }, { take, after }) =>
		Effect.orDie(
			query.run(
				{ kind, include_archived, agent_id, order },
				{ take, ...(after === undefined ? {} : { after }) },
			),
		).pipe(Effect.flatMap(decodePage), Effect.orDie),
	)
})

export class VaultListingQueries extends Context.Service<
	VaultListingQueries,
	{ readonly vaults: Query.Host; readonly credentials: Query.Host }
>()("@checkfu/api/VaultListingQueries") {}

export const vaultListingQueriesFrom = <E, R>(vaults: Layer.Layer<Model.Internals, E, R>) =>
	Layer.effect(
		VaultListingQueries,
		Effect.flatMap(Model.Internals, (internals) => {
			const listVaults = internals.queries.get(ListVaults.queryName)
			const listCredentials = internals.queries.get(ListCredentials.queryName)
			return listVaults === undefined || listCredentials === undefined
				? Effect.die(new Error("The Vaults model does not host its listing queries."))
				: Effect.succeed({ vaults: listVaults, credentials: listCredentials })
		}),
	).pipe(Layer.provide(vaults))

const paged = ({ take, after }: Query.PageRequest) => ({
	take,
	...(after === undefined ? {} : { after }),
})

export const makeVaultListers = Effect.gen(function* () {
	const queries = yield* VaultListingQueries
	return {
		vaults: listWith(({ include_archived, order }, page) =>
			Effect.orDie(queries.vaults.run({ include_archived, order }, paged(page))).pipe(
				Effect.flatMap(decodePage),
				Effect.orDie,
			),
		),
		credentials: listWith(
			({ include_archived, order, agent_id }, page) =>
				Effect.orDie(
					queries.credentials.run({ vault_id: agent_id, include_archived, order }, paged(page)),
				).pipe(Effect.flatMap(decodePage), Effect.orDie),
			ownedByVault,
		),
	}
})
