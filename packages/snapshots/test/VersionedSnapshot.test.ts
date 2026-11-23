import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { snapshotVersion, versionedSnapshot } from "../src/VersionedSnapshot.ts"

const V1 = Schema.Struct({ count: Schema.Int })
const V2 = Schema.Struct({ count: Schema.Int, label: Schema.String })
const V3 = Schema.Struct({ count: Schema.Int, label: Schema.String, active: Schema.Boolean })
const V4 = Schema.Struct({
	count: Schema.Int,
	label: Schema.String,
	active: Schema.Boolean,
	tier: Schema.String,
})

const makeV1Step = (calls?: Array<number>) =>
	snapshotVersion({
		version: 1 as const,
		schema: V1,
		migrate: (state) => {
			calls?.push(1)
			return { count: state.count, label: `n=${state.count}` }
		},
	})

const makeV2Step = (calls?: Array<number>) =>
	snapshotVersion({
		version: 2 as const,
		schema: V2,
		migrate: (state) => {
			calls?.push(2)
			return { ...state, active: state.count > 0 }
		},
	})

const makeV3Step = (calls?: Array<number>) =>
	snapshotVersion({
		version: 3 as const,
		schema: V3,
		migrate: (state) => {
			calls?.push(3)
			return { ...state, tier: state.active ? "pro" : "free" }
		},
	})

describe("versionedSnapshot", () => {
	it("round-trips the current version", () => {
		const codec = versionedSnapshot({ current: 1 as const, schema: V1 })
		const encode = Schema.encodeSync(codec)
		const decode = Schema.decodeUnknownSync(codec)

		const wire = encode({ count: 3 })
		expect(wire).toEqual({ schema_version: 1, state: { count: 3 } })
		expect(decode(wire)).toEqual({ count: 3 })
	})

	it("upgrades a previous version by one step and re-encodes at current", () => {
		const codec = versionedSnapshot({
			current: 2 as const,
			schema: V2,
			previous: [makeV1Step()],
		})
		const encode = Schema.encodeSync(codec)
		const decode = Schema.decodeUnknownSync(codec)

		const upgraded = decode({ schema_version: 1, state: { count: 3 } })
		expect(upgraded).toEqual({ count: 3, label: "n=3" })
		expect(encode(upgraded)).toEqual({
			schema_version: 2,
			state: { count: 3, label: "n=3" },
		})
	})

	it("runs each migration in a three-step chain once, in order", () => {
		const calls: Array<number> = []
		const codec = versionedSnapshot({
			current: 4 as const,
			schema: V4,
			previous: [makeV1Step(calls), makeV2Step(calls), makeV3Step(calls)],
		})
		const decode = Schema.decodeUnknownSync(codec)

		const fromV1 = decode({ schema_version: 1, state: { count: 2 } })
		expect(fromV1).toEqual({ count: 2, label: "n=2", active: true, tier: "pro" })
		expect(calls).toEqual([1, 2, 3])

		calls.length = 0
		const fromV2 = decode({ schema_version: 2, state: { count: 0, label: "zero" } })
		expect(fromV2).toEqual({ count: 0, label: "zero", active: false, tier: "free" })
		expect(calls).toEqual([2, 3])

		calls.length = 0
		const fromV3 = decode({
			schema_version: 3,
			state: { count: 1, label: "one", active: true },
		})
		expect(fromV3).toEqual({ count: 1, label: "one", active: true, tier: "pro" })
		expect(calls).toEqual([3])

		calls.length = 0
		const fromV4 = decode({
			schema_version: 4,
			state: { count: 5, label: "five", active: true, tier: "enterprise" },
		})
		expect(fromV4).toEqual({ count: 5, label: "five", active: true, tier: "enterprise" })
		expect(calls).toEqual([])
	})

	it("upgrades identically regardless of the order steps are listed in previous", () => {
		const codec = versionedSnapshot({
			current: 4 as const,
			schema: V4,
			previous: [makeV3Step(), makeV1Step(), makeV2Step()],
		})
		const decode = Schema.decodeUnknownSync(codec)

		expect(decode({ schema_version: 1, state: { count: 2 } })).toEqual({
			count: 2,
			label: "n=2",
			active: true,
			tier: "pro",
		})
	})

	it("fails decoding unknown snapshot versions", () => {
		const codec = versionedSnapshot({
			current: 4 as const,
			schema: V4,
			previous: [makeV1Step(), makeV2Step(), makeV3Step()],
		})
		const decodeExit = Schema.decodeUnknownExit(codec)

		expect(
			Exit.isFailure(
				decodeExit({
					schema_version: 5,
					state: { count: 1, label: "a", active: true, tier: "pro" },
				}),
			),
		).toBe(true)
		expect(Exit.isFailure(decodeExit({ schema_version: 0, state: { count: 1 } }))).toBe(true)
	})

	it("fails decoding when a stored state does not match its version schema", () => {
		const codec = versionedSnapshot({
			current: 2 as const,
			schema: V2,
			previous: [makeV1Step()],
		})
		const decodeExit = Schema.decodeUnknownExit(codec)

		expect(Exit.isFailure(decodeExit({ schema_version: 1, state: { count: "three" } }))).toBe(true)
	})

	it("fails decoding when a migration returns a state rejected by the current schema", () => {
		const codec = versionedSnapshot({
			current: 2 as const,
			schema: V2,
			previous: [
				snapshotVersion({
					version: 1 as const,
					schema: V1,
					migrate: (state) => ({ count: state.count }),
				}),
			],
		})
		const decodeExit = Schema.decodeUnknownExit(codec)

		expect(Exit.isFailure(decodeExit({ schema_version: 1, state: { count: 1 } }))).toBe(true)
	})

	it("rejects a previous version that is not less than current", () => {
		expect(() =>
			versionedSnapshot({
				current: 2 as const,
				schema: V2,
				previous: [makeV2Step()],
			}),
		).toThrow("must be less than current version 2")
	})

	it("rejects duplicate previous versions", () => {
		expect(() =>
			versionedSnapshot({
				current: 3 as const,
				schema: V3,
				previous: [makeV1Step(), makeV1Step()],
			}),
		).toThrow("Duplicate snapshot version 1")
	})
})
