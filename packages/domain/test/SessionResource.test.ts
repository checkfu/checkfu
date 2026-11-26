import { describe, expect, it } from "@effect/vitest"
import * as Schema from "effect/Schema"
import {
	MAX_SESSION_ARTIFACTS,
	MAX_SESSION_MEMORY_STORES,
	MAX_SESSION_REPOSITORIES,
	MemoryMountPath,
	MountPath,
	RepositoryCheckout,
	RepositoryMountPath,
	RepositoryToken,
	RepositoryUrl,
	SessionResources,
	artifactMountPath,
	memoryMountPath,
	mountsOverlap,
} from "../src/Session/SessionResource.ts"

const accepts = (schema: Schema.Top) => Schema.is(Schema.toType(schema))

const repository = (id: string, url: string, mount_path: string) => ({
	id,
	type: "github_repository" as const,
	url,
	mount_path,
	checkout: null,
})

describe("session resources", () => {
	it("takes only absolute mount paths that cannot climb, hide a character or leave a segment empty", () => {
		const valid = accepts(MountPath)
		for (const path of ["/workspace/api", "/mnt/memory/team notes", "/a/.hidden", "/a/b..c"]) {
			expect([path, valid(path)]).toEqual([path, true])
		}
		for (const path of [
			"",
			"/",
			"workspace/api",
			"/workspace/",
			"/workspace//api",
			"/workspace/./api",
			"/workspace/../etc",
			"/workspace/..",
			String.raw`/workspace\api`,
			"/workspace/a\u0000b",
			"/workspace/a\nb",
			`/${"a".repeat(1024)}`,
		]) {
			expect([path, valid(path)]).toEqual([path, false])
		}
	})

	it("mounts a repository only inside /workspace", () => {
		const valid = accepts(RepositoryMountPath)
		expect(valid("/workspace/api")).toBe(true)
		expect(valid("/workspace/code/api")).toBe(true)
		for (const path of ["/workspace", "/workspaces/api", "/mnt/api", "/workspace/../mnt"]) {
			expect([path, valid(path)]).toEqual([path, false])
		}
	})

	it("names a repository by its GitHub HTTPS address and nothing else", () => {
		const valid = accepts(RepositoryUrl)
		for (const url of [
			"https://github.com/acme/api",
			"https://github.com/a-b/My.Repo_2",
			"https://github.com/acme/.github",
		]) {
			expect([url, valid(url)]).toEqual([url, true])
		}
		for (const url of [
			"http://github.com/acme/api",
			"https://github.com/acme/api.git",
			"https://github.com/acme/api/",
			"https://github.com/acme/api/tree/main",
			"https://github.com/acme",
			"https://github.com/acme/..",
			"https://github.com/acme/.",
			"https://github.com/-acme/api",
			"https://token@github.com/acme/api",
			"https://github.com.evil.example/acme/api",
			"https://gitlab.com/acme/api",
			"git@github.com:acme/api",
			"https://github.com/acme/api?ref=main",
		]) {
			expect([url, valid(url)]).toEqual([url, false])
		}
	})

	it("checks out a named branch or a full commit id", () => {
		const valid = accepts(RepositoryCheckout)
		expect(valid({ type: "branch", name: "release/1.2" })).toBe(true)
		expect(valid({ type: "commit", sha: "0123456789abcdef0123456789abcdef01234567" })).toBe(true)
		expect(valid({ type: "branch", name: "" })).toBe(false)
		expect(valid({ type: "commit", sha: "0123456" })).toBe(false)
		expect(valid({ type: "commit", sha: "0123456789ABCDEF0123456789abcdef01234567" })).toBe(false)
		expect(valid({ type: "tag", name: "v1" })).toBe(false)
	})

	it("keeps a repository token out of anything that prints it", () => {
		const decode = Schema.decodeUnknownSync(Schema.toCodecJson(RepositoryToken))
		const token = decode("ghp_secret")
		expect(String(token)).not.toContain("ghp_secret")
		expect(JSON.stringify({ token })).not.toContain("ghp_secret")
		expect(() => decode("")).toThrow()
		expect(() => decode("x".repeat(4097))).toThrow()
	})

	it("says two mounts overlap when they are the same path or one holds the other", () => {
		expect(mountsOverlap("/workspace/api", "/workspace/api")).toBe(true)
		expect(mountsOverlap("/workspace/code", "/workspace/code/api")).toBe(true)
		expect(mountsOverlap("/workspace/code/api", "/workspace/code")).toBe(true)
		expect(mountsOverlap("/workspace/api", "/workspace/api-docs")).toBe(false)
		expect(mountsOverlap("/workspace/api", "/workspace/docs")).toBe(false)
	})

	it("admits a set of resources only with distinct ids, disjoint mounts and within the limit", () => {
		const valid = accepts(SessionResources)
		const api = repository("sesrsc_1", "https://github.com/acme/api", "/workspace/api")
		const docs = repository("sesrsc_2", "https://github.com/acme/docs", "/workspace/docs")
		expect(valid([])).toBe(true)
		expect(valid([api, docs])).toBe(true)
		expect(valid([api, { ...docs, id: api.id }])).toBe(false)
		expect(valid([api, { ...docs, mount_path: api.mount_path }])).toBe(false)
		expect(valid([api, { ...docs, mount_path: "/workspace/api/docs" }])).toBe(false)
		expect(valid([api, { ...docs, url: api.url }])).toBe(false)
		expect(valid([api, { ...docs, url: "https://github.com/ACME/Api" }])).toBe(false)
		const many = (count: number) =>
			Array.from({ length: count }, (_, index) =>
				repository(
					`sesrsc_${index}`,
					`https://github.com/acme/repo-${index}`,
					`/workspace/repo-${index}`,
				),
			)
		expect(valid(many(MAX_SESSION_REPOSITORIES))).toBe(true)
		expect(valid(many(MAX_SESSION_REPOSITORIES + 1))).toBe(false)
	})

	it("mounts a memory store under /mnt/memory at its name, made into one path segment", () => {
		expect(memoryMountPath("Team Notes", "memstore_1")).toBe("/mnt/memory/team-notes")
		expect(memoryMountPath("  User's Preferences (2026)!  ", "memstore_1")).toBe(
			"/mnt/memory/user-s-preferences-2026",
		)
		expect(memoryMountPath("Résumé Notes", "memstore_1")).toBe("/mnt/memory/résumé-notes")
		expect(memoryMountPath("../../etc", "memstore_1")).toBe("/mnt/memory/etc")
		expect(memoryMountPath("!!!", "memstore_1")).toBe("/mnt/memory/memstore_1")
		const valid = accepts(MemoryMountPath)
		expect(valid("/mnt/memory/team-notes")).toBe(true)
		for (const path of ["/mnt/memory", "/mnt/memory/a/b", "/mnt/other/a", "/workspace/a"]) {
			expect([path, valid(path)]).toEqual([path, false])
		}
	})

	it("admits up to 8 memory stores beside 8 repositories, each store once", () => {
		const valid = accepts(SessionResources)
		const store = (index: number, memory_store_id = `memstore_${index}`) => ({
			id: `sesrsc_m${index}`,
			type: "memory_store" as const,
			memory_store_id,
			access: "read_write" as const,
			instructions: null,
			name: `Store ${index}`,
			description: "",
			mount_path: `/mnt/memory/store-${index}`,
		})
		const repositories = Array.from({ length: MAX_SESSION_REPOSITORIES }, (_, index) =>
			repository(
				`sesrsc_r${index}`,
				`https://github.com/acme/repo-${index}`,
				`/workspace/repo-${index}`,
			),
		)
		const stores = (count: number) => Array.from({ length: count }, (_, index) => store(index))
		expect(valid([...repositories, ...stores(MAX_SESSION_MEMORY_STORES)])).toBe(true)
		expect(valid(stores(MAX_SESSION_MEMORY_STORES + 1))).toBe(false)
		expect(valid([store(1), store(2, "memstore_1")])).toBe(false)
		expect(valid([store(1), { ...store(2), mount_path: "/mnt/memory/store-1" }])).toBe(false)
		expect(valid([{ ...store(1), access: "write_only" }])).toBe(false)
		expect(valid([{ ...store(1), instructions: "x".repeat(4097) }])).toBe(false)
		expect(valid([{ ...store(1), mount_path: "/workspace/store-1" }])).toBe(false)
	})

	it("mounts an artifact under /mnt/artifacts at its name, and admits up to 8 of them", () => {
		expect(artifactMountPath("Q3 Data", "art_1")).toBe("/mnt/artifacts/q3-data")
		expect(artifactMountPath("../../etc", "art_1")).toBe("/mnt/artifacts/etc")
		expect(artifactMountPath("!!!", "art_1")).toBe("/mnt/artifacts/art_1")
		const valid = accepts(SessionResources)
		const artifact = (index: number) => ({
			id: `sesrsc_a${index}`,
			type: "artifact" as const,
			artifact_id: `art_${index}`,
			version: 1,
			manifest: "a".repeat(64),
			name: `Set ${index}`,
			mount_path: `/mnt/artifacts/set-${index}`,
		})
		const artifacts = (count: number) =>
			Array.from({ length: count }, (_, index) => artifact(index))
		expect(valid(artifacts(MAX_SESSION_ARTIFACTS))).toBe(true)
		expect(valid(artifacts(MAX_SESSION_ARTIFACTS + 1))).toBe(false)
		expect(valid([artifact(1), { ...artifact(2), mount_path: "/mnt/artifacts/set-1" }])).toBe(false)
		expect(valid([{ ...artifact(1), version: 0 }])).toBe(false)
		expect(valid([{ ...artifact(1), manifest: "" }])).toBe(false)
		expect(valid([{ ...artifact(1), mount_path: "/mnt/memory/set-1" }])).toBe(false)
		expect(valid([{ ...artifact(1), mount_path: "/mnt/artifacts/a/b" }])).toBe(false)
	})
})
