import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "@effect/vitest"
import { purgeTables } from "../src/Workspace/WorkspaceStorage.ts"

describe("workspace storage", () => {
	it("empties every table of the workspace, change history included, and leaves the platform's own", () => {
		const db = new DatabaseSync(":memory:")
		db.exec(`
			CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB);
			CREATE TABLE vfs_nodes (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT);
			CREATE TABLE vfs_changes (path TEXT, kind TEXT);
			CREATE TABLE "odd ""name""" (x TEXT);
			INSERT INTO _cf_KV VALUES ('discarded', 'true');
			INSERT INTO vfs_nodes (path) VALUES ('/workspace/secret.txt');
			INSERT INTO vfs_changes VALUES ('/workspace/secret.txt', 'delete');
			INSERT INTO "odd ""name""" VALUES ('kept?');
		`)
		purgeTables({ exec: (query) => db.prepare(query).all() })
		const count = (table: string) =>
			Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.["n"])
		expect(count("vfs_nodes")).toBe(0)
		expect(count("vfs_changes")).toBe(0)
		expect(count('"odd ""name"""')).toBe(0)
		expect(count("_cf_KV")).toBe(1)
		// The tables stay, empty, so nothing that still holds the filesystem open breaks.
		expect(
			db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all(),
		).toEqual([
			{ name: "_cf_KV" },
			{ name: 'odd "name"' },
			{ name: "sqlite_sequence" },
			{ name: "vfs_changes" },
			{ name: "vfs_nodes" },
		])
	})
})
