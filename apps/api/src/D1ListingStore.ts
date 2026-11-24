import * as Cloudflare from "@alchemy.run/cloudflare"
import {
	ARCHIVED,
	LISTED,
	ListingStore,
	listingCursor,
	parseListingCursor,
} from "@checkfu/domain/Listing/ListingStore"
import type { ListingOrder } from "@checkfu/domain/Listing/ListingStore"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { placement } from "./Placement.ts"
import type { Placement } from "./Placement.ts"

export const listingDatabaseProps = ({
	jurisdiction,
}: Placement): Effect.Effect<Cloudflare.D1.DatabaseProps> =>
	jurisdiction === "fedramp-high"
		? Effect.die(
				new Error(
					"D1 has no fedramp-high jurisdiction, so the listing database cannot be placed with the Durable Objects.",
				),
			)
		: Effect.succeed({
				migrations: "apps/api/migrations",
				...(jurisdiction === undefined
					? {}
					: {
							// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Cloudflare's D1 create API takes "us"; Alchemy's Jurisdiction type predates it
							jurisdiction: jurisdiction as Cloudflare.D1.Jurisdiction,
						}),
			})

export const ListingDatabase = Cloudflare.D1.Database(
	"ListingDatabase",
	Effect.orDie(Effect.flatMap(placement, listingDatabaseProps)),
)

const UPSERT =
	"INSERT INTO listing (kind, id, created_at, agent_id, status) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (kind, id) DO UPDATE SET status = MAX(status, excluded.status)"

export const listingPageQuery = (
	order: ListingOrder,
	includeArchived: boolean,
	byAgent: boolean,
	after: boolean,
) =>
	[
		"SELECT id, created_at FROM listing WHERE kind = ?1",
		includeArchived ? `AND status <= ${ARCHIVED}` : `AND status = ${LISTED}`,
		byAgent ? "AND agent_id = ?2" : "AND ?2 IS NULL",
		after
			? `AND (created_at, id) ${order === "asc" ? ">" : "<"} (?3, ?4)`
			: "AND ?3 IS NULL AND ?4 IS NULL",
		`ORDER BY created_at ${order}, id ${order} LIMIT ?5`,
	].join(" ")

export const makeD1ListingStore = (db: Cloudflare.D1.QueryDatabaseClient) =>
	ListingStore.of({
		record: (changes) =>
			changes.length === 0
				? Effect.void
				: Effect.asVoid(
						db.batch(
							changes.map((change) =>
								db
									.prepare(UPSERT)
									.bind(change.kind, change.id, change.created_at, change.agent_id, change.status),
							),
						),
					),
		page: (filter, { after, take }) => {
			const cursor = after === undefined ? undefined : parseListingCursor(after)
			return Effect.map(
				db
					.prepare(
						listingPageQuery(
							filter.order,
							filter.include_archived,
							filter.agent_id !== null,
							cursor !== undefined,
						),
					)
					.bind(
						filter.kind,
						filter.agent_id,
						cursor?.created_at ?? null,
						cursor?.id ?? null,
						take + 1,
					)
					.all<{ readonly id: string; readonly created_at: number }>(),
				({ results }) => {
					const page = results.slice(0, take)
					const last = page.at(-1)
					return {
						entries: page.map(({ id }) => ({ id })),
						cursor: results.length > take && last !== undefined ? listingCursor(last) : null,
					}
				},
			)
		},
	})

export const D1ListingStore = Layer.effect(
	ListingStore,
	Effect.gen(function* () {
		return makeD1ListingStore(yield* Cloudflare.D1.QueryDatabase(yield* ListingDatabase))
	}),
)
