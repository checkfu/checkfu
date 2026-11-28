import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { makeCustodyDatabase } from "./helpers/CustodyDatabase.ts"
import { openOAuthCustodyFixture } from "./helpers/OAuthCustodyFixture.ts"
import type { RefreshReply } from "./helpers/OAuthCustodyFixture.ts"

const credential = "cred_fixture"
const target = "https://resource.example.test/mcp"
const otherTarget = "https://other.example.test/mcp"
const firstAccess = "private-fixture-access-1"
const firstRefresh = "private-fixture-refresh-1"
const rotated = {
	type: "rotated",
	access: "private-fixture-access-2",
	refresh: "private-fixture-refresh-2",
} as const

const renewed = {
	type: "rotated",
	access: "private-fixture-new-access",
	refresh: "private-fixture-new-refresh",
} as const

function fixture(reply: (refresh: string) => RefreshReply | Promise<RefreshReply> = () => rotated) {
	const db = makeCustodyDatabase()
	const sent: Array<string> = []
	const sentRefresh: Array<string> = []
	const dispatched = Promise.withResolvers<void>()
	const reopen = (beforeSend?: () => Promise<void>) =>
		openOAuthCustodyFixture(
			db.sql,
			async (resource, refresh) => {
				expect(resource).toBe(target)
				sent.push(resource)
				sentRefresh.push(refresh)
				dispatched.resolve()
				return reply(refresh)
			},
			beforeSend,
		)
	const owner = reopen()
	expect(owner.authorize(credential, target, firstAccess, firstRefresh)).toBe(true)
	const decodePair = Schema.decodeUnknownSync(
		Schema.Struct({
			access_token: Schema.NullOr(Schema.String),
			refresh_token: Schema.NullOr(Schema.String),
		}),
	)
	const pair = (id: string) => {
		const rows: ReadonlyArray<unknown> = Array.from(
			db.sql.exec(
				"SELECT access_token, refresh_token FROM oauth_grants WHERE credential_id = ?",
				id,
			),
		)
		return rows.map((row) => {
			const { access_token, refresh_token } = decodePair(row)
			return [access_token, refresh_token]
		})
	}
	return { db, owner, reopen, sent, sentRefresh, pair, dispatched: dispatched.promise }
}

describe("OAuth grant custody qualification", () => {
	it("shares one rotating refresh and exposes only metadata", async () => {
		const waiting = Promise.withResolvers<RefreshReply>()
		const { owner, reopen, sent, sentRefresh, pair, dispatched } = fixture(() => waiting.promise)
		expect(owner.tokenFor(credential, otherTarget)).toBeNull()
		expect(owner.tokenFor(credential, target)).toBe(firstAccess)
		const first = owner.refresh(credential)
		const second = owner.refresh(credential)
		expect(first).toBe(second)
		await dispatched
		expect(owner.overview(credential)).toMatchObject({ status: "refreshing", generation: 1 })
		expect(owner.tokenFor(credential, target)).toBeNull()
		waiting.resolve(rotated)
		expect(await Promise.all([first, second])).toEqual(["ready", "ready"])
		expect(sent).toEqual([target])
		expect(sentRefresh).toEqual([firstRefresh])

		const restarted = reopen()
		expect(restarted.overview(credential)).toEqual({
			id: credential,
			target,
			generation: 2,
			status: "ready",
		})
		expect(restarted.tokenFor(credential, target)).toBe(rotated.access)
		expect(pair(credential)).toEqual([[rotated.access, rotated.refresh]])
		expect(restarted.tokenFor(credential, otherTarget)).toBeNull()
		const publicValue = JSON.stringify(restarted.overview(credential))
		for (const secret of [firstAccess, firstRefresh, rotated.access, rotated.refresh]) {
			expect(publicValue).not.toContain(secret)
		}
	})

	it("does not contact the provider if recording the dispatch intent fails", async () => {
		const { db, owner, reopen, sent } = fixture()
		db.failAt("UPDATE oauth_grants SET dispatched = 1")
		await expect(owner.refresh(credential)).rejects.toThrow("stopped at UPDATE")
		expect(sent).toEqual([])
		expect(reopen().tokenFor(credential, target)).toBe(firstAccess)
		expect(await reopen().refresh(credential)).toBe("ready")
		expect(sent).toEqual([target])
	})

	it("requires reauthorization after an intent survives a restart before the send", async () => {
		const { reopen, sent } = fixture()
		const parked = Promise.withResolvers<void>()
		const interrupted = reopen(() => parked.promise).refresh(credential)
		const recovery = reopen()
		expect(recovery.overview(credential)).toMatchObject({ status: "refreshing", generation: 1 })
		expect(await recovery.refresh(credential)).toBe("reauthorize")
		parked.resolve()
		expect(await interrupted).toBe("superseded")
		expect(sent).toEqual([])
		expect(recovery.tokenFor(credential, target)).toBeNull()
	})

	it.each(["lost reply", "failed commit"] as const)(
		"does not repeat a dispatched refresh after a %s",
		async (failure) => {
			const { db, owner, reopen, sent, pair } = fixture(() => {
				if (failure === "lost reply") {
					throw new Error("The rotating response was lost.")
				}
				db.failCommit()
				return rotated
			})
			await expect(owner.refresh(credential)).rejects.toThrow(
				failure === "failed commit" ? "stopped before COMMIT" : "rotating response was lost",
			)
			expect(pair(credential)).toEqual([[firstAccess, firstRefresh]])
			const restarted = reopen()
			expect(restarted.overview(credential)).toMatchObject({ status: "refreshing", generation: 1 })
			expect(await restarted.refresh(credential)).toBe("reauthorize")
			expect(await reopen().refresh(credential)).toBe("reauthorize")
			expect(restarted.tokenFor(credential, target)).toBeNull()
			expect(pair(credential)).toEqual([[null, null]])
			expect(sent).toEqual([target])
		},
	)

	it("invalidates an unexpired grant on definitive provider revocation", async () => {
		const { owner, reopen, sent, pair } = fixture(() => ({ type: "revoked" }))
		expect(await owner.refresh(credential)).toBe("reauthorize")
		expect(await reopen().refresh(credential)).toBe("reauthorize")
		expect(reopen().tokenFor(credential, target)).toBeNull()
		expect(pair(credential)).toEqual([[null, null]])
		expect(sent).toEqual([target])
	})

	it.each(["credential", "vault", "new authorization"] as const)(
		"refuses a late result after changing the %s",
		async (ending) => {
			const waiting = Promise.withResolvers<RefreshReply>()
			const { owner, reopen, sent, pair, dispatched } = fixture(() => waiting.promise)
			const other = "cred_other"
			expect(owner.authorize(other, otherTarget, firstAccess, firstRefresh)).toBe(true)
			const refresh = owner.refresh(credential)
			await dispatched
			const replacement = reopen()
			if (ending === "credential") {
				replacement.erase(credential)
			} else if (ending === "vault") {
				replacement.seal()
			} else {
				expect(replacement.authorize(credential, target, renewed.access, renewed.refresh)).toBe(
					true,
				)
			}
			waiting.resolve(rotated)
			expect(await refresh).toBe(ending === "new authorization" ? "superseded" : "erased")
			expect(reopen().tokenFor(credential, target)).toBe(
				ending === "new authorization" ? renewed.access : null,
			)
			if (ending !== "new authorization") {
				expect(await reopen().refresh(credential)).toBe("erased")
				expect(reopen().authorize(credential, target, firstAccess, firstRefresh)).toBe(false)
			}
			expect(pair(credential)).toEqual(
				ending === "new authorization" ? [[renewed.access, renewed.refresh]] : [[null, null]],
			)
			expect(reopen().tokenFor(other, otherTarget)).toBe(ending === "vault" ? null : firstAccess)
			expect(pair(other)).toEqual(
				ending === "vault" ? [[null, null]] : [[firstAccess, firstRefresh]],
			)
			expect(sent).toEqual([target])
		},
	)
	it("starts a refresh for a new generation while the superseded caller is still waiting", async () => {
		const waiting = Promise.withResolvers<RefreshReply>()
		const { owner, sentRefresh, pair, dispatched } = fixture((refresh) =>
			refresh === renewed.refresh ? rotated : waiting.promise,
		)
		const old = owner.refresh(credential)
		await dispatched
		expect(owner.authorize(credential, target, renewed.access, renewed.refresh)).toBe(true)
		expect(await owner.refresh(credential)).toBe("ready")
		waiting.resolve({ type: "revoked" })
		expect(await old).toBe("superseded")
		expect(sentRefresh).toEqual([firstRefresh, renewed.refresh])
		expect(pair(credential)).toEqual([[rotated.access, rotated.refresh]])
	})
})
