import { readFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import * as Cloudflare from "@alchemy.run/cloudflare"
import { ARCHIVED, DELETED, LISTED, ListingStore } from "@checkfu/domain/Listing/ListingStore"
import type { ListingFilter } from "@checkfu/domain/Listing/ListingStore"
import { describe, expect, it } from "@effect/vitest"
import { RuntimeContext } from "alchemy/RuntimeContext"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { AgentId, ResourceListCursor } from "@checkfu/sdk/Schemas"
import {
	listingDatabaseProps,
	listingPageQuery,
	makeD1ListingStore,
} from "../src/D1ListingStore.ts"

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

const row = (
	kind: "agent" | "environment" | "session",
	id: string,
	created_at: number,
	status: typeof LISTED | typeof ARCHIVED | typeof DELETED = LISTED,
	agent_id: string | null = null,
) => ({ kind, id, created_at, agent_id, status })

describe.each(Object.entries(stores))("ListingStore (%s)", (_name, store) => {
	const provided = <A, E>(effect: Effect.Effect<A, E, ListingStore | RuntimeContext>) =>
		effect.pipe(Effect.provide([store, RuntimeContext.phantom]))

	it.effect("filters by kind, status and agent, and moves a status only forward", () =>
		provided(
			Effect.gen(function* () {
				const listing = yield* ListingStore
				yield* listing.record([
					row("session", "s1", 1, LISTED, "a1"),
					row("session", "s2", 2, LISTED, "a2"),
					row("session", "s3", 3, LISTED, "a1"),
					row("environment", "e1", 4),
					row("agent", "s1", 5),
				])
				yield* listing.record([
					row("session", "s2", 9, ARCHIVED),
					row("session", "s2", 9, LISTED),
					row("environment", "e1", 9, DELETED),
					row("environment", "e1", 9, ARCHIVED),
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
				expect(yield* listing.get("session", "s1")).toEqual({ id: "s1", created_at: 1 })
				expect(yield* listing.get("session", "s2")).toBeNull()
				expect(yield* listing.get("environment", "e1")).toBeNull()
				expect(yield* listing.get("agent", "s1")).toEqual({ id: "s1", created_at: 5 })
				expect(yield* listing.get("agent", "missing")).toBeNull()
			}),
		),
	)

	it.effect("moves a row to its new agent, and keeps the agent when a change names none", () =>
		provided(
			Effect.gen(function* () {
				const listing = yield* ListingStore
				yield* listing.record([row("session", "s1", 1, LISTED, "a1")])
				yield* listing.record([row("session", "s1", 5, LISTED, "a2")])
				yield* listing.record([row("session", "s1", 9, ARCHIVED)])
				yield* listing.record([row("session", "s2", 3, LISTED, "a2")])
				expect(
					ids(yield* listing.page(filter({ agent_id: "a1", include_archived: true }), first)),
				).toEqual([])
				expect(
					ids(yield* listing.page(filter({ agent_id: "a2", include_archived: true }), first)),
				).toEqual(["s1", "s2"])
				expect(ids(yield* listing.page(filter({ include_archived: true }), first))).toEqual([
					"s1",
					"s2",
				])
			}),
		),
	)

	it.effect("orders by creation time, then id, whatever order the rows were recorded in", () =>
		provided(
			Effect.gen(function* () {
				const listing = yield* ListingStore
				yield* listing.record([row("session", "s3", 30), row("session", "s2b", 20)])
				yield* listing.record([row("session", "s1", 10), row("session", "s2a", 20)])
				yield* listing.record([row("session", "s1", 99, ARCHIVED)])
				expect(ids(yield* listing.page(filter({ include_archived: true }), first))).toEqual([
					"s1",
					"s2a",
					"s2b",
					"s3",
				])
				expect(
					ids(yield* listing.page(filter({ include_archived: true, order: "desc" }), first)),
				).toEqual(["s3", "s2b", "s2a", "s1"])
			}),
		),
	)

	it.effect("pages by creation time in either order, through ties, and ends with no cursor", () =>
		provided(
			Effect.gen(function* () {
				const listing = yield* ListingStore
				yield* listing.record([
					row("session", "s1", 10),
					row("session", "s2", 20),
					row("session", "s3", 20),
				])
				const head = yield* listing.page(filter(), { after: undefined, take: 2 })
				expect(ids(head)).toEqual(["s1", "s2"])
				expect(head.cursor).toEqual("20:s2")
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

describe("list cursors", () => {
	it.effect.each(Object.entries(stores))(
		"page through every id a resource id may hold (%s)",
		([, store]) =>
			Effect.gen(function* () {
				const listing = yield* ListingStore
				const odd = ["agent.v2", "a:b", "x y", "\u00fc", "a%2F", "\u{10000}", "\uE000"]
				expect(odd.every(Schema.is(AgentId))).toBe(true)
				yield* listing.record(odd.map((id) => row("agent", id, 7)))
				const seen: Array<string> = []
				let after: string | undefined
				for (let page = 0; page < odd.length; page++) {
					const next = yield* listing.page(filter({ kind: "agent" }), { after, take: 1 })
					seen.push(...ids(next))
					if (next.cursor === null) {
						break
					}
					expect(Schema.is(ResourceListCursor)(next.cursor)).toBe(true)
					after = next.cursor
				}
				expect(seen).toEqual(["a%2F", "a:b", "agent.v2", "x y", "\u00fc", "\uE000", "\u{10000}"])
			}).pipe(Effect.provide([store, RuntimeContext.phantom])),
	)
})

describe("D1 listing queries", () => {
	it("seek through the partial index that holds only the rows the page may return", () => {
		const sqlite = new DatabaseSync(":memory:")
		sqlite.exec(readFileSync(new URL("../migrations/0001_listing.sql", import.meta.url), "utf8"))
		const plan = (order: "asc" | "desc", archived: boolean, byAgent: boolean, after: boolean) =>
			sqlite
				.prepare(`EXPLAIN QUERY PLAN ${listingPageQuery(order, archived, byAgent, after)}`)
				.all("session", byAgent ? "a1" : null, after ? 1 : null, after ? "s1" : null, 2)
				.map((step) => String(step["detail"]))
				.join(" | ")
		for (const order of ["asc", "desc"] as const) {
			for (const after of [false, true]) {
				for (const [archived, prefix] of [
					[false, "listing_live"],
					[true, "listing_kept"],
				] as const) {
					expect(plan(order, archived, true, after)).toMatch(
						new RegExp(`USING (COVERING )?INDEX ${prefix}_by_agent \\(`),
					)
					expect(plan(order, archived, false, after)).toMatch(
						new RegExp(`USING (COVERING )?INDEX ${prefix} \\(`),
					)
					expect(plan(order, archived, true, after)).not.toContain("TEMP B-TREE")
					expect(plan(order, archived, false, after)).not.toContain("TEMP B-TREE")
				}
			}
		}
	})
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
