import * as Cloudflare from "@alchemy.run/cloudflare"
import { ARCHIVED, LISTED, ListingStore } from "@checkfu/domain/Listing/ListingStore"
import type { ListingEntry } from "@checkfu/domain/Listing/ListingStore"
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
	"INSERT INTO listing (kind, id, agent_id, status) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (kind, id) DO UPDATE SET status = MAX(status, excluded.status)"

const pageQuery = (order: "asc" | "desc") =>
	`SELECT id, position FROM listing WHERE kind = ?1 AND status <= ?2 AND (?3 IS NULL OR agent_id = ?3) AND position ${order === "asc" ? ">" : "<"} ?4 ORDER BY position ${order === "asc" ? "ASC" : "DESC"} LIMIT ?5`

export const makeD1ListingStore = (db: Cloudflare.D1.QueryDatabaseClient) =>
	ListingStore.of({
		record: (changes) =>
			changes.length === 0
				? Effect.void
				: Effect.asVoid(
						db.batch(
							changes.map((change) =>
								db.prepare(UPSERT).bind(change.kind, change.id, change.agent_id, change.status),
							),
						),
					),
		page: (filter, { after, take }) =>
			Effect.map(
				db
					.prepare(pageQuery(filter.order))
					.bind(
						filter.kind,
						filter.include_archived ? ARCHIVED : LISTED,
						filter.agent_id,
						after === undefined
							? filter.order === "asc"
								? 0
								: Number.MAX_SAFE_INTEGER
							: Number(after),
						take + 1,
					)
					.all<ListingEntry>(),
				({ results }) => {
					const entries = results.slice(0, take).map(({ id, position }) => ({ id, position }))
					return {
						entries,
						cursor: results.length > take ? String(entries.at(-1)?.position) : null,
					}
				},
			),
	})

export const D1ListingStore = Layer.effect(
	ListingStore,
	Effect.gen(function* () {
		return makeD1ListingStore(yield* Cloudflare.D1.QueryDatabase(yield* ListingDatabase))
	}),
)
