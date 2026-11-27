import { describe, expect, it } from "@effect/vitest"
import {
	DATA_OPERATIONS,
	accessAt,
	both,
	declaredFor,
	decodeGrant,
	encodeGrant,
	grantAt,
	grantedFor,
	permits,
} from "../src/Artifact/ArtifactAccess.ts"
import type { CollectionAccess } from "../src/Artifact/ArtifactAccess.ts"

const ACCESS = ["none", "read", "add", "write"] as const
const LEVELS = ["view", "read", "write"] as const

const allowed = (access: CollectionAccess) =>
	DATA_OPERATIONS.filter((operation) => permits(access, operation))

describe("What a visitor may do with a collection", () => {
	it("follows the table: the address's level and the collection's visitors setting", () => {
		const table = Object.fromEntries(
			LEVELS.map((level) => [
				level,
				Object.fromEntries(
					ACCESS.map((visitors) => [visitors, allowed(accessAt(level, visitors))]),
				),
			]),
		)
		expect(table).toEqual({
			view: { none: [], read: [], add: [], write: [] },
			read: { none: [], read: ["list", "get"], add: [], write: ["list", "get"] },
			write: {
				none: [],
				read: ["list", "get"],
				add: ["add"],
				write: ["list", "get", "add", "put", "delete"],
			},
		})
	})

	it("allows under two grants exactly the operations both allow", () => {
		for (const one of ACCESS) {
			for (const other of ACCESS) {
				expect([one, other, allowed(both(one, other))]).toEqual([
					one,
					other,
					allowed(one).filter((operation) => permits(other, operation)),
				])
			}
		}
	})

	it("never lets a higher level or a later version give more than was granted", () => {
		for (const level of LEVELS) {
			for (const then of ACCESS) {
				const granted = accessAt(level, then)
				for (const now of ACCESS) {
					for (const current of LEVELS) {
						const effective = allowed(both(granted, accessAt(current, now)))
						expect(effective.every((operation) => permits(granted, operation))).toBe(true)
						expect(effective.every((operation) => permits(now, operation))).toBe(true)
					}
				}
			}
		}
	})

	it("records, for a level, each declared collection a visitor could use and nothing else", () => {
		const capabilities = {
			database: {
				collections: {
					votes: { visitors: "add" },
					settings: { visitors: "read" },
					notes: { visitors: "write" },
					secrets: { visitors: "none" },
				},
			},
		} as const
		expect(grantAt("view", capabilities)).toEqual({})
		expect(grantAt("read", capabilities)).toEqual({ notes: "read", settings: "read" })
		expect(grantAt("write", capabilities)).toEqual({
			notes: "write",
			settings: "read",
			votes: "add",
		})
		expect(grantAt("write", {})).toEqual({})
		expect(declaredFor(capabilities, "votes")).toBe("add")
		expect(declaredFor(capabilities, "undeclared")).toBe("none")
		expect(declaredFor(capabilities, "constructor")).toBe("none")
		expect(grantedFor({ votes: "add" }, "votes")).toBe("add")
		expect(grantedFor({ votes: "add" }, "toString")).toBe("none")
	})

	it("keeps a grant as the same text whatever order it was built in", () => {
		const text = encodeGrant({ votes: "add", notes: "write" })
		expect(text).toBe('{"notes":"write","votes":"add"}')
		expect(encodeGrant({ notes: "write", votes: "add" })).toBe(text)
		expect(decodeGrant(text ?? "")).toEqual({ notes: "write", votes: "add" })
		expect(encodeGrant({})).toBe("")
		expect(decodeGrant("")).toEqual({})
		expect(decodeGrant("not json")).toEqual({})
		expect(decodeGrant('{"votes":"everything"}')).toEqual({})
	})
})
