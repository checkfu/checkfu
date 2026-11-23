import { describe, expect, it } from "@effect/vitest"
import {
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
})
