import { DatabaseSync } from "node:sqlite"
import type { SQLInputValue } from "node:sqlite"
import type { CustodySql } from "../../src/Connection/SecretCustody.ts"

export interface CustodyRows {
	readonly secrets: ReadonlyArray<string>
	readonly tombstones: ReadonlyArray<string>
	readonly sealed: boolean
}

export const makeCustodyDatabase = () => {
	const db = new DatabaseSync(":memory:")
	let failNext: string | undefined
	const sql: CustodySql = {
		exec: (query, ...bindings) => {
			if (failNext !== undefined && query.startsWith(failNext)) {
				failNext = undefined
				throw new Error(`stopped at ${query}`)
			}
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
				const result = run()
				db.exec("COMMIT")
				return result
			} catch (error) {
				db.exec("ROLLBACK")
				throw error
			}
		},
	}
	const ids = (query: string): ReadonlyArray<string> =>
		db
			.prepare(query)
			.all()
			.map((row) => String(row["credential_id"]))
	return {
		sql,
		failAt: (statementPrefix: string) => {
			failNext = statementPrefix
		},
		rows: (): CustodyRows => ({
			secrets: ids("SELECT credential_id FROM secrets ORDER BY credential_id"),
			tombstones: ids("SELECT credential_id FROM tombstones ORDER BY credential_id"),
			sealed: db.prepare("SELECT 1 FROM vault WHERE sealed = 1").all().length > 0,
		}),
		stored: (): string =>
			JSON.stringify(
				["secrets", "tombstones", "vault"].map((table) =>
					db.prepare(`SELECT * FROM ${table}`).all(),
				),
			),
	}
}
