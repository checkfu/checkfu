import * as Model from "@alchemy.run/domain/Model"
import * as Query from "@alchemy.run/domain/Query"
import { ListingEntry, listingCursor } from "@checkfu/domain/Listing/ListingStore"
import type { ListingFilter, ListingKind, ListingOrder } from "@checkfu/domain/Listing/ListingStore"
import { ListResources } from "@checkfu/domain/Listing/ListResources.query"
import { ListCredentials } from "@checkfu/domain/Vault/ListCredentials.query"
import { ListVaults } from "@checkfu/domain/Vault/ListVaults.query"
import { ListWebhooks } from "@checkfu/domain/Webhook/ListWebhooks.query"
import { ERRORS } from "@checkfu/sdk/Api"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
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

const isConsistencyTimeout = (error: unknown): boolean =>
	typeof error === "object" &&
	error !== null &&
	"_tag" in error &&
	error._tag === "ConsistencyTimeout"

export class WebhookListingTimeout extends Data.TaggedError("WebhookListingTimeout")<{
	readonly receipt: Query.AtLeast
}> {}

export interface WebhookListingQueryService {
	readonly page: (
		order: ListingOrder,
		options?: Query.RunOptions,
	) => Effect.Effect<Query.Page<ListingEntry>, WebhookListingTimeout>
	readonly lookup: (id: string) => Effect.Effect<Query.Page<ListingEntry>, WebhookListingTimeout>
	readonly waitFor: (receipt: Query.AtLeast) => Effect.Effect<void, WebhookListingTimeout>
}

export class WebhookListingQuery extends Context.Service<
	WebhookListingQuery,
	WebhookListingQueryService
>()("@checkfu/api/WebhookListingQuery") {}

/**
 * Captures the `Webhooks` model's `ListWebhooks` query host before it is merged
 * alongside the `Checkfu` model (whose own `Model.Internals` would otherwise
 * shadow `Webhooks`'s `Model.Internals`).
 */
export const WebhookListingQueryLive = Layer.effect(
	WebhookListingQuery,
	Effect.gen(function* () {
		const query = (yield* Model.Internals).queries.get(ListWebhooks.queryName)
		if (query === undefined) {
			return yield* Effect.die(new Error("ListWebhooks is not hosted by the Webhooks model."))
		}
		const runQuery = (
			input: { readonly order: ListingOrder; readonly id?: string | null },
			options: Query.RunOptions = {},
		): Effect.Effect<Query.Page<ListingEntry>, WebhookListingTimeout> =>
			Effect.gen(function* () {
				const exit = yield* Effect.exit(Effect.orDie(query.run(input, options)))
				if (Exit.isFailure(exit)) {
					const error = Cause.squash(exit.cause)
					if (isConsistencyTimeout(error) && options.atLeast !== undefined) {
						const [receipt] = Query.receiptsOf(options.atLeast)
						if (receipt !== undefined) {
							return yield* new WebhookListingTimeout({ receipt })
						}
					}
					return yield* Effect.failCause(exit.cause)
				}
				return yield* decodePage(exit.value).pipe(Effect.orDie)
			})
		return {
			page: (order, options) => runQuery({ order }, options),
			lookup: (id) => runQuery({ order: "asc", id }, { take: 1 }),
			waitFor: (receipt) =>
				Effect.asVoid(runQuery({ order: "asc" }, { take: 1, atLeast: receipt })),
		}
	}),
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

export const hydratePage = <Entry, A extends object, E, R>(
	entries: ReadonlyArray<Entry>,
	retrieve: (entry: Entry) => Effect.Effect<A | null, E, R>,
) =>
	Effect.gen(function* () {
		const data: Array<A> = []
		let bytes = 0
		let lastHandled: Entry | undefined
		let firstOmitted: Entry | undefined
		yield* Stream.fromIterable(entries).pipe(
			Stream.mapEffect(
				(entry) => Effect.map(Effect.exit(retrieve(entry)), (outcome) => ({ entry, outcome })),
				{ concurrency: HYDRATE_CONCURRENCY },
			),
			Stream.runForEachWhile(({ entry, outcome }) =>
				Effect.gen(function* () {
					const resource = yield* outcome
					if (resource !== null) {
						const size = utf8.encode(JSON.stringify(resource)).length
						const next = pageBytesWith(bytes, data.length, size)
						if (data.length > 0 && next > LIST_PAGE_BYTES) {
							firstOmitted = entry
							return false
						}
						bytes = next
						data.push(resource)
					}
					lastHandled = entry
					return true
				}),
			),
		)
		return { data, lastHandled, firstOmitted }
	})

export const hydrateListingPage = <A extends object, E, R>(
	page: Query.Page<ListingEntry>,
	input: Pick<ListQuery, "include_archived" | "agent_id">,
	retrieve: (id: string) => Effect.Effect<A, E, R>,
	ownedBy: OwnedBy = ownedByAgent,
) =>
	Effect.gen(function* () {
		const includeArchived = input.include_archived ?? false
		const { data, lastHandled, firstOmitted } = yield* hydratePage(page.entries, (entry) =>
			retrieve(entry.id).pipe(
				Effect.catchIf(isNotFound, () => Effect.succeed(null)),
				Effect.map((resource) => {
					if (
						resource === null ||
						(!includeArchived && "archived_at" in resource && resource.archived_at !== null) ||
						(input.agent_id !== undefined && !ownedBy(resource, input.agent_id))
					) {
						return null
					}
					return resource
				}),
			),
		)
		const cursor =
			firstOmitted !== undefined && lastHandled !== undefined
				? listingCursor(lastHandled)
				: page.cursor
		return listPage(data, cursor)
	})

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
			return yield* hydrateListingPage(page, input, retrieve, ownedBy)
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
