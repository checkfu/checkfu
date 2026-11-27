import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { versionedSnapshot } from "../src/VersionedSnapshot.ts"

const codec = versionedSnapshot({ current: 1, schema: Schema.Struct({ count: Schema.Int }) })

describe("versionedSnapshot", () => {
	it("round-trips the current version", () => {
		const wire = Schema.encodeSync(codec)({ count: 3 })
		expect(wire).toEqual({ schema_version: 1, state: { count: 3 } })
		expect(Schema.decodeSync(codec)(wire)).toEqual({ count: 3 })
	})

	it("fails decoding unknown snapshot versions", () => {
		const decode = Schema.decodeUnknownExit(codec)
		expect(Exit.isFailure(decode({ schema_version: 2, state: { count: 1 } }))).toBe(true)
		expect(Exit.isFailure(decode({ schema_version: 0, state: { count: 1 } }))).toBe(true)
	})

	it("fails decoding an invalid state in the current version", () => {
		const decode = Schema.decodeUnknownExit(codec)
		expect(Exit.isFailure(decode({ schema_version: 1, state: { count: "three" } }))).toBe(true)
	})
})
