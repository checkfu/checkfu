import { describe, expect, it } from "vitest"
import { ApiError } from "../src/api.ts"
import { lookup, present } from "../src/queries.ts"
import { returnTo } from "../src/return-to.ts"
import { selection } from "../src/selection.ts"
import { sessionTitle } from "../src/session-title.ts"

describe("returning after sign-in", () => {
	it("keeps a same-origin path with its search and hash", () => {
		expect(returnTo("/sessions/sess_1?x=1#end")).toBe("/sessions/sess_1?x=1#end")
	})

	it("refuses anything that could leave the dashboard or loop back to sign-in", () => {
		for (const value of [
			undefined,
			42,
			"",
			"sessions",
			"//evil.example/x",
			String.raw`/\evil.example`,
			"https://evil.example/",
			"/sign-in?redirect=/agents",
		]) {
			expect(returnTo(value)).toBeUndefined()
		}
	})
})

describe("choosing an agent or environment", () => {
	const options = [{ id: "a" }, { id: "b" }]

	it("defaults to the first option only until something is chosen", () => {
		expect(selection(options, undefined)).toEqual({ id: "a", gone: false })
		expect(selection(options, "b")).toEqual({ id: "b", gone: false })
	})

	it("asks for a new choice when the chosen one disappears, instead of substituting another", () => {
		expect(selection(options, "c")).toEqual({ id: "", gone: true })
		expect(selection([], "a")).toEqual({ id: "", gone: true })
	})
})

describe("detail pages", () => {
	it("stop showing cached data once the server confirms the resource is gone", () => {
		const cached = { name: "env" }
		expect(present({ data: cached, error: null })).toBe(cached)
		expect(present({ data: cached, error: new ApiError(503, "overloaded_error", "busy") })).toBe(
			cached,
		)
		expect(() =>
			present({
				data: cached,
				error: new ApiError(404, "not_found_error", "Environment not found."),
			}),
		).toThrow("Environment not found.")
	})

	it("read one resource as pending, active, gone or failed, a failed recheck failing despite cached data", () => {
		const vault = { archived_at: null as string | null }
		const active = (found: typeof vault) => found.archived_at === null
		expect(lookup({ data: undefined, error: null }, active)).toEqual({ state: "pending" })
		expect(lookup({ data: vault, error: null }, active)).toEqual({ state: "active", found: vault })
		expect(lookup({ data: { archived_at: "2026-11-24" }, error: null }, active)).toEqual({
			state: "gone",
		})
		expect(lookup({ data: vault, error: new ApiError(404, null, "gone") }, active)).toEqual({
			state: "gone",
		})
		expect(lookup({ data: undefined, error: new ApiError(404, null, "gone") }, active)).toEqual({
			state: "gone",
		})
		expect(lookup({ data: undefined, error: new ApiError(503, null, "busy") }, active)).toEqual({
			state: "failed",
		})
		expect(lookup({ data: vault, error: new ApiError(503, null, "busy") }, active)).toEqual({
			state: "failed",
		})
	})
})

describe("session titles", () => {
	it("treats a blank title as missing", () => {
		expect(sessionTitle({ title: null })).toBeUndefined()
		expect(sessionTitle({ title: "   " })).toBeUndefined()
		expect(sessionTitle({ title: " Plan " })).toBe(" Plan ")
	})
})
