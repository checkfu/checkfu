import { describe, expect, it } from "vitest"
import {
	checkoutOf,
	describeResource,
	emptyDraft,
	namesResource,
	resourceBody,
	resourceIdentity,
} from "../src/session-resources.ts"
import type { ResourceDraft } from "../src/session-resources.ts"

const repository = (fields: Partial<Extract<ResourceDraft, { type: "github_repository" }>>) =>
	({
		type: "github_repository",
		url: "https://github.com/acme/api",
		token: "",
		checkout: "",
		checkoutKind: "default",
		mountPath: "",
		access: "read_write",
		...fields,
	}) satisfies ResourceDraft

describe("session resources", () => {
	it("sends only what was filled in, so the API applies its defaults", () => {
		expect(resourceBody(repository({ url: " https://github.com/acme/api " }))).toEqual({
			type: "github_repository",
			url: "https://github.com/acme/api",
		})
		expect(
			resourceBody({
				type: "memory_store",
				memoryStoreId: "memstore_1",
				access: "read_write",
				instructions: "",
			}),
		).toEqual({
			type: "memory_store",
			memory_store_id: "memstore_1",
			access: "read_write",
		})
		expect(resourceBody({ type: "skill", artifactId: "art_1", version: " 3 " })).toEqual({
			type: "skill",
			artifact_id: "art_1",
			version: 3,
		})
	})

	it("sends a repository's token but leaves it out of what identifies the request", () => {
		const first = repository({ token: "ghp_old" })
		const replaced = repository({ token: "ghp_new" })
		expect(resourceBody(first)).toMatchObject({ authorization_token: "ghp_old" })
		expect(resourceIdentity(first)).toEqual(resourceIdentity(replaced))
		expect(resourceIdentity(first)).not.toHaveProperty("authorization_token")
		expect(resourceIdentity(repository({ url: "https://github.com/acme/web" }))).not.toEqual(
			resourceIdentity(first),
		)
	})

	it("uses the selected checkout kind and validates commit IDs independently of branch names", () => {
		const sha = "a".repeat(40)
		expect(checkoutOf("default", "")).toEqual({})
		expect(
			resourceBody(repository({ checkoutKind: "commit", checkout: sha.toUpperCase() })),
		).toMatchObject({
			checkout: { type: "commit", sha },
		})
		for (const abbreviated of ["a1b2", "a1b2c3d", "a".repeat(39)]) {
			expect(checkoutOf("commit", abbreviated)).toEqual({
				error: "Enter the full 40-character commit ID.",
			})
		}
		expect(() => resourceBody(repository({ checkoutKind: "commit", checkout: "a1b2c3d" }))).toThrow(
			"full 40-character",
		)
		for (const name of ["release/1.0", "a1b2c3d", sha]) {
			expect(resourceBody(repository({ checkoutKind: "branch", checkout: name }))).toMatchObject({
				checkout: { type: "branch", name },
			})
		}
	})

	it("includes read-only access when selected", () => {
		expect(resourceBody(repository({ access: "read_only" }))).toMatchObject({ access: "read_only" })
		expect(resourceBody(repository({ access: "read_write" }))).not.toHaveProperty("access")
	})

	it("describes a mounted resource in a line", () => {
		expect(
			describeResource({
				id: "sesrsc_1",
				type: "memory_store",
				memory_store_id: "memstore_1",
				access: "read_only",
				instructions: null,
				name: "Notes",
				description: "",
				mount_path: "/mnt/memory/notes",
				created_at: "2026-11-24T00:00:00.000Z",
				updated_at: "2026-11-24T00:00:00.000Z",
			}),
		).toEqual({ label: "Memory store", name: "Notes", detail: "read-only" })
		expect(
			describeResource({
				id: "sesrsc_2",
				type: "github_repository",
				url: "https://github.com/acme/api",
				mount_path: "/workspace/api",
				checkout: null,
				access: "read_only",
				created_at: "2026-11-24T00:00:00.000Z",
				updated_at: "2026-11-24T00:00:00.000Z",
			}),
		).toEqual({
			label: "Repository",
			name: "https://github.com/acme/api",
			detail: "default branch · read-only",
		})
	})

	it("counts a row as ready only once it names what it mounts", () => {
		const types = ["github_repository", "memory_store", "artifact", "skill"] as const
		expect(types.map((type) => namesResource(emptyDraft(type)))).toEqual([
			false,
			false,
			false,
			false,
		])
		expect(namesResource(repository({ url: "  " }))).toBe(false)
		expect(namesResource(repository({}))).toBe(true)
		expect(
			namesResource({
				type: "memory_store",
				memoryStoreId: "memstore_1",
				access: "read_only",
				instructions: "",
			}),
		).toBe(true)
		expect(namesResource({ type: "skill", artifactId: "art_1", version: "" })).toBe(true)
	})
})
