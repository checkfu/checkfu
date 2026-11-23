import { DatabaseSync } from "node:sqlite"
import type { SQLInputValue } from "node:sqlite"
import { describe, expect, it } from "@effect/vitest"
import { MIGRATIONS, SqliteTurnFence } from "../src/Pi/TurnFence.ts"
import type { SqlExecutor } from "../src/Pi/TurnFence.ts"

const executor = (db: DatabaseSync): SqlExecutor => ({
	exec: (query, ...bindings) => {
		const statement = db.prepare(query)
		const values = bindings as ReadonlyArray<SQLInputValue>
		if (statement.columns().length > 0) {
			return statement.all(...values)
		}
		statement.run(...values)
		return []
	},
	transaction: (run) => {
		db.exec("BEGIN")
		try {
			run()
			db.exec("COMMIT")
		} catch (error) {
			db.exec("ROLLBACK")
			throw error
		}
	},
})

const migrationCount = (db: DatabaseSync): number =>
	db.prepare("SELECT id FROM checkfu_fence_migrations").all().length

const tableExists = (db: DatabaseSync, name: string): boolean =>
	db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").all(name).length > 0

describe("SqliteTurnFence", () => {
	it("starts with nothing cancelled", () => {
		const fence = new SqliteTurnFence(executor(new DatabaseSync(":memory:")))
		expect(fence.isCancelled("op-1")).toBe(false)
	})

	it("marks cancellations idempotently and distinguishes ids", () => {
		const fence = new SqliteTurnFence(executor(new DatabaseSync(":memory:")))
		fence.markCancelled("op-1")
		fence.markCancelled("op-1")
		expect(fence.isCancelled("op-1")).toBe(true)
		expect(fence.isCancelled("op-2")).toBe(false)
	})

	it("keeps cancellations across a new instance over the same database", () => {
		const db = new DatabaseSync(":memory:")
		new SqliteTurnFence(executor(db)).markCancelled("op-1")
		const second = new SqliteTurnFence(executor(db))
		expect(second.isCancelled("op-1")).toBe(true)
		expect(second.isCancelled("op-2")).toBe(false)
		expect(migrationCount(db)).toBe(1)
	})

	it("applies a later migration to an existing database", () => {
		const db = new DatabaseSync(":memory:")
		new SqliteTurnFence(executor(db)).markCancelled("op-1")
		expect(tableExists(db, "fence_test_marker")).toBe(false)
		const second = new SqliteTurnFence(executor(db), [
			...MIGRATIONS,
			["CREATE TABLE fence_test_marker (id INTEGER PRIMARY KEY)"],
		])
		expect(second.isCancelled("op-1")).toBe(true)
		expect(tableExists(db, "fence_test_marker")).toBe(true)
		expect(migrationCount(db)).toBe(2)
	})

	it("leaves nothing behind when a migration fails part-way, so a retry can apply it", () => {
		const db = new DatabaseSync(":memory:")
		const broken = new SqliteTurnFence(executor(db), [
			...MIGRATIONS,
			["CREATE TABLE fence_test_marker (id INTEGER PRIMARY KEY)", "CREATE TABLE ("],
		])
		expect(() => broken.isCancelled("op-1")).toThrow(/syntax error|incomplete input/i)
		expect(tableExists(db, "fence_test_marker")).toBe(false)
		expect(migrationCount(db)).toBe(1)

		const fixed = new SqliteTurnFence(executor(db), [
			...MIGRATIONS,
			["CREATE TABLE fence_test_marker (id INTEGER PRIMARY KEY)"],
		])
		expect(fixed.isCancelled("op-1")).toBe(false)
		expect(tableExists(db, "fence_test_marker")).toBe(true)
		expect(migrationCount(db)).toBe(2)
	})
})
