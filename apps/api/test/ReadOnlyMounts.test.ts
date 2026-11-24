import { describe, expect, it } from "@effect/vitest"
import {
	followLinks,
	readOnlyMountOf,
	readOnlyMountOfGit,
	resolvePath,
} from "../src/Workspace/ReadOnlyMounts.ts"

const MOUNTS = ["/mnt/memory/handbook", "/mnt/artifacts/q3-data"]

describe("read-only mounts", () => {
	it("resolves a path the way the filesystem does", () => {
		expect(resolvePath("/mnt/memory/./handbook//rules.md")).toBe("/mnt/memory/handbook/rules.md")
		expect(resolvePath("/workspace/../mnt/memory/handbook")).toBe("/mnt/memory/handbook")
		expect(resolvePath("notes/../a.md")).toBe("/workspace/a.md")
		expect(resolvePath("../mnt/x", "/workspace/repo")).toBe("/workspace/mnt/x")
		expect(resolvePath("/../../etc")).toBe("/etc")
		expect(resolvePath("/")).toBe("/")
	})

	it("finds the mount of a path however the path is spelled", () => {
		for (const path of [
			"/mnt/memory/handbook",
			"/mnt/memory/handbook/rules.md",
			"/mnt/memory/./handbook/rules.md",
			"/mnt/memory//handbook/rules.md",
			"/mnt/memory/other/../handbook/rules.md",
			"/workspace/../mnt/memory/handbook/deep/file.md",
			"../mnt/memory/handbook/rules.md",
		]) {
			expect([path, readOnlyMountOf(MOUNTS, path)]).toEqual([path, "/mnt/memory/handbook"])
		}
		for (const path of [
			"/mnt/memory/handbook-2/rules.md",
			"/mnt/memory/handbook/../team/rules.md",
			"/mnt/memory",
			"/workspace/mnt/memory/handbook/rules.md",
			"mnt/memory/handbook/rules.md",
		]) {
			expect([path, readOnlyMountOf(MOUNTS, path)]).toEqual([path, undefined])
		}
	})

	it("counts a mount as touched by a call that removes a directory above it", () => {
		const removing = (path: string) => readOnlyMountOf(MOUNTS, path, { subtree: true })
		expect(removing("/mnt/memory")).toBe("/mnt/memory/handbook")
		expect(removing("/mnt")).toBe("/mnt/memory/handbook")
		expect(removing("/")).toBe("/mnt/memory/handbook")
		expect(removing("/mnt/artifacts/")).toBe("/mnt/artifacts/q3-data")
		expect(removing("/workspace/../mnt/memory")).toBe("/mnt/memory/handbook")
		expect(removing("/mnt/memory/handbook/rules.md")).toBe("/mnt/memory/handbook")
		expect(removing("/mnt/memory/hand")).toBeUndefined()
		expect(removing("/mnt/memory/team")).toBeUndefined()
		expect(removing("/workspace")).toBeUndefined()
		// Writing one file above a mount touches nothing below it.
		expect(readOnlyMountOf(MOUNTS, "/mnt/memory")).toBeUndefined()
	})

	it("finds the mount a git command would work in, by directory or by argument", () => {
		const inMount = (args: ReadonlyArray<string>, cwd: string) =>
			readOnlyMountOfGit(MOUNTS, args, cwd)
		expect(inMount(["init"], "/mnt/artifacts/q3-data")).toBe("/mnt/artifacts/q3-data")
		expect(inMount(["init"], "/mnt/artifacts/./q3-data/sub")).toBe("/mnt/artifacts/q3-data")
		expect(inMount(["-C", "../../mnt/memory/handbook", "init"], "/workspace/repo")).toBe(
			"/mnt/memory/handbook",
		)
		expect(inMount(["--work-tree=/mnt/memory/handbook", "checkout", "."], "/workspace/repo")).toBe(
			"/mnt/memory/handbook",
		)
		expect(
			inMount(["clone", "https://github.com/acme/api", "/mnt/artifacts/q3-data/api"], "/workspace"),
		).toBe("/mnt/artifacts/q3-data")
		expect(inMount(["status"], "/workspace/repo")).toBeUndefined()
		expect(inMount(["commit", "-m", "Update /mnt notes"], "/workspace/repo")).toBeUndefined()
		expect(inMount(["add", "mnt/memory/handbook"], "/workspace/repo")).toBeUndefined()
	})

	it("follows symbolic links along a path to what a call on it would reach", async () => {
		const links = new Map([
			["/workspace/repo/notes", "/mnt/memory/handbook"],
			["/workspace/repo/up", "../../mnt/artifacts"],
			["/workspace/repo/loop", "/workspace/repo/loop"],
		])
		const existing = new Set([
			"/workspace",
			"/workspace/repo",
			"/mnt",
			"/mnt/memory",
			"/mnt/artifacts",
		])
		const reader = {
			lstat: (path: string) =>
				links.has(path) || existing.has(path)
					? Promise.resolve({ isSymbolicLink: links.has(path) })
					: Promise.reject(new Error(`ENOENT: ${path}`)),
			readlink: (path: string) => Promise.resolve(links.get(path) ?? ""),
		}
		const reached = (path: string) => followLinks(path, reader)
		expect(await reached("/workspace/repo/notes/rules.md")).toBe("/mnt/memory/handbook/rules.md")
		expect(await reached("/workspace/repo/up/q3-data/new.csv")).toBe(
			"/mnt/artifacts/q3-data/new.csv",
		)
		expect(await reached("/workspace/repo/plain/file.md")).toBe("/workspace/repo/plain/file.md")
		expect(await reached("/workspace/repo/loop/x")).toBe("/workspace/repo/loop/x")
		expect(readOnlyMountOf(MOUNTS, await reached("/workspace/repo/notes/rules.md"))).toBe(
			"/mnt/memory/handbook",
		)
	})
})
