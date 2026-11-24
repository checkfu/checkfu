import { readFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import * as Cloudflare from "@alchemy.run/cloudflare"
import { ARCHIVED, DELETED, LISTED, ListingStore } from "@checkfu/domain/Listing/ListingStore"
import type { ListingFilter } from "@checkfu/domain/Listing/ListingStore"
import { describe, expect, it } from "@effect/vitest"
import { RuntimeContext } from "alchemy/RuntimeContext"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { listingDatabaseProps, makeD1ListingStore } from "../src/D1ListingStore.ts"

const sqliteD1 = (): Cloudflare.D1.QueryDatabaseClient => {
	const sqlite = new DatabaseSync(":memory:")
	sqlite.exec(readFileSync(new URL("../migrations/0001_listing.sql", import.meta.url), "utf8"))
	const statement = (query: string, values: ReadonlyArray<unknown>) => {
		const runNow = () => sqlite.prepare(query).run(...(values as Array<never>))
		return {
			bind: (...next: ReadonlyArray<unknown>) => statement(query, next),
			all: () =>
				Promise.resolve({ results: sqlite.prepare(query).all(...(values as Array<never>)) }),
			runNow,
		}
	}
	const raw = {
		prepare: (query: string) => statement(query, []),
		batch: (statements: ReadonlyArray<ReturnType<typeof statement>>) => {
			sqlite.exec("BEGIN")
			try {
				for (const each of statements) {
					each.runNow()
				}
				sqlite.exec("COMMIT")
				return Promise.resolve(statements.map(() => ({ results: [] })))
			} catch (error) {
				sqlite.exec("ROLLBACK")
				return Promise.reject(error)
			}
		},
	} as unknown as Effect.Success<Cloudflare.D1.QueryDatabaseClient["raw"]>
	const rawEff = Effect.succeed(raw)
	return {
		raw: rawEff,
		prepare: (query) => new Cloudflare.D1.PreparedStatement(query, [], rawEff),
		exec: (query) => Effect.promise(() => raw.exec(query)),
		batch: (statements) =>
			Effect.promise(() => raw.batch(statements.map((each) => each._build(raw)))),
	}
}

const stores = {
	memory: ListingStore.memory,
	d1: Layer.sync(ListingStore, () => makeD1ListingStore(sqliteD1())),
}

const filter = (overrides: Partial<ListingFilter> = {}): ListingFilter => ({
	kind: "session",
	include_archived: false,
	agent_id: null,
	order: "asc",
	...overrides,
})

const ids = (page: { readonly entries: ReadonlyArray<{ readonly id: string }> }) =>
	page.entries.map((entry) => entry.id)

const first = { after: undefined, take: 10 }

describe.each(Object.entries(stores))("ListingStore (%s)", (_name, store) => {
	const provided = <A, E>(effect: Effect.Effect<A, E, ListingStore | RuntimeContext>) =>
		effect.pipe(Effect.provide([store, RuntimeContext.phantom]))

	it.effect("keeps creation order and moves a status only forward", () =>
		provided(
			Effect.gen(function* () {
				const listing = yield* ListingStore
				yield* listing.record([
					{ kind: "session", id: "s1", agent_id: "a1", status: LISTED },
					{ kind: "session", id: "s2", agent_id: "a2", status: LISTED },
					{ kind: "session", id: "s3", agent_id: "a1", status: LISTED },
					{ kind: "environment", id: "e1", agent_id: null, status: LISTED },
					{ kind: "agent", id: "s1", agent_id: null, status: LISTED },
				])
				yield* listing.record([
					{ kind: "session", id: "s2", agent_id: null, status: ARCHIVED },
					{ kind: "session", id: "s2", agent_id: null, status: LISTED },
					{ kind: "environment", id: "e1", agent_id: null, status: DELETED },
					{ kind: "environment", id: "e1", agent_id: null, status: ARCHIVED },
				])
				yield* listing.record([])
				expect(ids(yield* listing.page(filter(), first))).toEqual(["s1", "s3"])
				expect(ids(yield* listing.page(filter({ include_archived: true }), first))).toEqual([
					"s1",
					"s2",
					"s3",
				])
				expect(
					ids(yield* listing.page(filter({ include_archived: true, agent_id: "a2" }), first)),
				).toEqual(["s2"])
				expect(ids(yield* listing.page(filter({ agent_id: "a1", order: "desc" }), first))).toEqual([
					"s3",
					"s1",
				])
				expect(
					ids(yield* listing.page(filter({ kind: "environment", include_archived: true }), first)),
				).toEqual([])
				expect(ids(yield* listing.page(filter({ kind: "agent" }), first))).toEqual(["s1"])
			}),
		),
	)

	it.effect("pages by position in either order and ends with no cursor", () =>
		provided(
			Effect.gen(function* () {
				const listing = yield* ListingStore
				yield* listing.record(
					["s1", "s2", "s3"].map((id) => ({
						kind: "session" as const,
						id,
						agent_id: null,
						status: LISTED,
					})),
				)
				const head = yield* listing.page(filter(), { after: undefined, take: 2 })
				expect(ids(head)).toEqual(["s1", "s2"])
				expect(head.cursor).toEqual(String(head.entries[1]?.position))
				const tail = yield* listing.page(filter(), { after: head.cursor ?? undefined, take: 2 })
				expect(tail).toMatchObject({ cursor: null })
				expect(ids(tail)).toEqual(["s3"])
				expect((yield* listing.page(filter(), { after: undefined, take: 3 })).cursor).toBeNull()

				const newest = yield* listing.page(filter({ order: "desc" }), {
					after: undefined,
					take: 2,
				})
				expect(ids(newest)).toEqual(["s3", "s2"])
				const oldest = yield* listing.page(filter({ order: "desc" }), {
					after: newest.cursor ?? undefined,
					take: 2,
				})
				expect(oldest).toMatchObject({ cursor: null })
				expect(ids(oldest)).toEqual(["s1"])
			}),
		),
	)
})

describe("listing database placement", () => {
	it.effect("follows the Durable Objects' jurisdiction and ignores their location hint", () =>
		Effect.gen(function* () {
			const migrations = "apps/api/migrations"
			expect(yield* listingDatabaseProps({})).toEqual({ migrations })
			expect(yield* listingDatabaseProps({ jurisdiction: "eu", locationHint: "weur" })).toEqual({
				migrations,
				jurisdiction: "eu",
			})
			expect(yield* listingDatabaseProps({ jurisdiction: "us" })).toEqual({
				migrations,
				jurisdiction: "us",
			})
			expect(yield* listingDatabaseProps({ locationHint: "enam" })).toEqual({ migrations })
			const refused = yield* Effect.exit(listingDatabaseProps({ jurisdiction: "fedramp-high" }))
			expect(refused._tag).toBe("Failure")
		}),
	)
})
