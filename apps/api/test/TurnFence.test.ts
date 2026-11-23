import { DatabaseSync } from "node:sqlite"
import type { SQLInputValue } from "node:sqlite"
import { describe, expect, it } from "@effect/vitest"
import { SqliteTurnFence } from "../src/Pi/TurnFence.ts"
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
})

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
	})
})
