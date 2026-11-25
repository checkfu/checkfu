import { describe, expect, it } from "vitest"
import { ARTIFACT_WRITE_GRACE_MS } from "../src/Artifacts/ArtifactOwnership.ts"
import { settleBeforeFence, settleWrite } from "../src/Artifacts/ArtifactReconcile.ts"
import { listedMarkers } from "../src/Artifacts/ArtifactStore.ts"
import { DEFAULT_STORAGE_SCOPE } from "../src/Placement.ts"

const create = { kind: "create", manifest: "m1" } as const
const version = { kind: "version", manifest: "m3", expected_version: 2 } as const
const state = (status: string, at: number, manifest: string) => ({
	status,
	version: at,
	manifest,
})

describe("settleWrite, the decision after the fence", () => {
	it.each([
		["a create that never landed", create, state("", 0, ""), null, "abandon"],
		["a create that landed", create, state("active", 1, "m1"), null, "confirm"],
		[
			"a create whose artifact moved on",
			create,
			state("active", 3, "m9"),
			{ manifest: "m1" },
			"confirm",
		],
		[
			"a create whose version row is not projected yet",
			create,
			state("active", 2, "m2"),
			null,
			"wait",
		],
		["a create that lost to other files", create, state("active", 1, "m2"), null, "abandon"],
		["a create of an artifact since deleted", create, state("deleted", 1, "m1"), null, "abandon"],
		["a version that never landed", version, state("active", 2, "m2"), null, "abandon"],
		["a version that landed", version, state("active", 3, "m3"), null, "confirm"],
		[
			"a version that landed and was followed",
			version,
			state("active", 4, "m4"),
			{ manifest: "m3" },
			"confirm",
		],
		["a version that lost the race", version, state("active", 3, "m9"), null, "abandon"],
		[
			"a version that lost the race, followed",
			version,
			state("active", 4, "m4"),
			{ manifest: "m9" },
			"abandon",
		],
		["a version of an artifact since deleted", version, state("deleted", 3, "m3"), null, "abandon"],
	] as const)("settles %s", (_name, check, current, row, expected) => {
		expect(settleWrite(check, current, row)).toBe(expected)
	})
})

describe("settleBeforeFence", () => {
	it.each([
		["a create that never landed", create, state("", 0, ""), null, "fence"],
		["a create that landed", create, state("active", 1, "m1"), null, "confirm"],
		[
			"a create whose version row is not projected yet",
			create,
			state("active", 2, "m2"),
			null,
			"wait",
		],
		["a create that lost to other files", create, state("active", 1, "m2"), null, "abandon"],
		[
			"a create that lost to other files, followed",
			create,
			state("active", 2, "m2"),
			{ manifest: "m9" },
			"abandon",
		],
		["a create of an artifact since deleted", create, state("deleted", 1, "m1"), null, "abandon"],
		["a version that never landed", version, state("active", 2, "m2"), null, "fence"],
		["a version still behind its expected head", version, state("active", 1, "m1"), null, "fence"],
		["a version that landed", version, state("active", 3, "m3"), null, "confirm"],
		[
			"a version that landed and was followed",
			version,
			state("active", 4, "m4"),
			{ manifest: "m3" },
			"confirm",
		],
		["a version that lost the race", version, state("active", 3, "m9"), null, "abandon"],
		[
			"a version that lost the race, followed",
			version,
			state("active", 4, "m4"),
			{ manifest: "m9" },
			"abandon",
		],
		[
			"a version of an artifact since deleted, which never landed",
			version,
			state("deleted", 2, "m2"),
			null,
			"abandon",
		],
		[
			"a version of an artifact since deleted, which had landed",
			version,
			state("deleted", 3, "m3"),
			null,
			"abandon",
		],
	] as const)("reads %s", (_name, check, current, row, expected) => {
		expect(settleBeforeFence(check, current, row)).toBe(expected)
	})
})

describe("listedMarkers", () => {
	it("names each marker's write in its scope and measures its age in milliseconds from its upload", () => {
		const now = Date.UTC(2026, 10, 23, 12)
		const listed = listedMarkers(
			DEFAULT_STORAGE_SCOPE,
			[
				{
					key: "reconcile/default/art_old/w1",
					uploaded: new Date(now - ARTIFACT_WRITE_GRACE_MS - 1),
				},
				{ key: "reconcile/default/art_new/w2", uploaded: new Date(now - 1000) },
				{ key: "reconcile/default/stray", uploaded: new Date(now) },
				{ key: "reconcile/eu/art_old/w3", uploaded: new Date(now) },
				{ key: "reconcile/art_old/w4", uploaded: new Date(now) },
			],
			now,
		)
		expect(listed).toEqual([
			{
				artifact_id: "art_old",
				write_id: "w1",
				key: "reconcile/default/art_old/w1",
				age: ARTIFACT_WRITE_GRACE_MS + 1,
			},
			{ artifact_id: "art_new", write_id: "w2", key: "reconcile/default/art_new/w2", age: 1000 },
		])
	})
})
