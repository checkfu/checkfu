import { describe, expect, it } from "@effect/vitest"
import * as Schema from "effect/Schema"
import { SessionCreated } from "../src/Session/CreateSession.command.ts"
import { RunTurn } from "../src/Session/RunTurn.saga.ts"
import {
	MAX_SESSION_REPOSITORIES,
	MountPath,
	RepositoryCheckout,
	RepositoryMountPath,
	RepositoryToken,
	RepositoryUrl,
	SessionResources,
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

	it("reads a session and a queued turn written before resources existed as having none", () => {
		const event = Schema.decodeSync(Schema.toCodecJson(SessionCreated))({
			_tag: "session.created",
			agent_id: "agent_1",
			agent_version: 1,
			environment_id: "env_1",
			title: null,
		})
		expect(event.resources).toEqual([])

		const turn = Schema.decodeSync(Schema.toCodecJson(RunTurn.workflow.payloadSchema))({
			key: "sess_1:turn:1",
			session_id: "sess_1",
			agent_id: "agent_1",
			agent_version: 1,
			environment_id: "env_1",
			turn: 1,
			generation: 0,
			input: ["Hello"],
		})
		expect(turn.resources).toEqual([])
	})
})
