export interface SqlExecutor {
	exec(query: string, ...bindings: ReadonlyArray<unknown>): Iterable<Record<string, unknown>>
	transaction(run: () => void): void
}

export type Migration = ReadonlyArray<string>

export const MIGRATIONS: ReadonlyArray<Migration> = [
	["CREATE TABLE checkfu_cancelled_ops (operation_id TEXT PRIMARY KEY)"],
]

const applyMigrations = (sql: SqlExecutor, migrations: ReadonlyArray<Migration>): void => {
	sql.exec("CREATE TABLE IF NOT EXISTS checkfu_fence_migrations (id INTEGER PRIMARY KEY)")
	const applied = new Set<unknown>(
		[...sql.exec("SELECT id FROM checkfu_fence_migrations")].map((row) => row["id"]),
	)
	migrations.forEach((statements, index) => {
		const id = index + 1
		if (applied.has(id)) return
		sql.transaction(() => {
			for (const statement of statements) {
				sql.exec(statement)
			}
			sql.exec("INSERT INTO checkfu_fence_migrations (id) VALUES (?)", id)
		})
	})
}

export class SqliteTurnFence {
	readonly #sql: SqlExecutor
	readonly #migrations: ReadonlyArray<Migration>
	#initialized = false

	constructor(sql: SqlExecutor, migrations: ReadonlyArray<Migration> = MIGRATIONS) {
		this.#sql = sql
		this.#migrations = migrations
	}

	#ensureTables(): void {
		if (this.#initialized) return
		applyMigrations(this.#sql, this.#migrations)
		this.#initialized = true
	}

	isCancelled(operationId: string): boolean {
		this.#ensureTables()
		const rows = [
			...this.#sql.exec(
				"SELECT 1 FROM checkfu_cancelled_ops WHERE operation_id = ? LIMIT 1",
				operationId,
			),
		]
		return rows.length > 0
	}

	markCancelled(operationId: string): void {
		this.#ensureTables()
		this.#sql.exec(
			"INSERT OR IGNORE INTO checkfu_cancelled_ops (operation_id) VALUES (?)",
			operationId,
		)
	}
}
