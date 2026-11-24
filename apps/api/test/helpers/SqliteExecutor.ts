import { DatabaseSync } from "node:sqlite"
import type { SQLInputValue } from "node:sqlite"
import type { SqlExecutor } from "../../src/Pi/PiMcpStore.ts"

/** A session object's SQLite, in memory. */
export const memorySql = (): SqlExecutor => {
	const db = new DatabaseSync(":memory:")
	return {
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
	}
}
