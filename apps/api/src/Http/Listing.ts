import * as Model from "@alchemy.run/domain/Model"
import * as Query from "@alchemy.run/domain/Query"
import { ListingEntry, listingCursor } from "@checkfu/domain/Listing/ListingStore"
import type { ListingKind, ListingOrder } from "@checkfu/domain/Listing/ListingStore"
import { ListResources } from "@checkfu/domain/Listing/ListResources.query"
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
		const runPage = (
			order: ListingOrder,
			options: Query.RunOptions = {},
		): Effect.Effect<Query.Page<ListingEntry>, WebhookListingTimeout> =>
			Effect.gen(function* () {
				const exit = yield* Effect.exit(Effect.orDie(query.run({ order }, options)))
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
			page: runPage,
			waitFor: (receipt) => Effect.asVoid(runPage("asc", { take: 1, atLeast: receipt })),
		}
	}),
)

export const hydrateListingPage = <A extends object, E, R>(
	page: Query.Page<ListingEntry>,
	input: Pick<ListQuery, "include_archived" | "agent_id">,
	retrieve: (id: string) => Effect.Effect<A, E, R>,
) =>
	Effect.gen(function* () {
		const include_archived = input.include_archived ?? false
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
					const agentMatches =
						resource !== null &&
						(input.agent_id === undefined ||
							("agent" in resource &&
								Predicate.hasProperty(resource.agent, "id") &&
								resource.agent.id === input.agent_id))
					if (resource !== null && agentMatches && (include_archived || !archived)) {
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
			return yield* hydrateListingPage(page, input, retrieve)
		})
})
