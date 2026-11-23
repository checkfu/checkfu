export interface SqlExecutor {
	exec(query: string, ...bindings: ReadonlyArray<unknown>): Iterable<object>
}

export const CANCELLED_OPS_TABLE =
	"CREATE TABLE IF NOT EXISTS checkfu_cancelled_ops (operation_id TEXT PRIMARY KEY)"

export class SqliteTurnFence {
	readonly #sql: SqlExecutor
	#created = false

	constructor(sql: SqlExecutor) {
		this.#sql = sql
	}

	#table(): SqlExecutor {
		if (!this.#created) {
			this.#sql.exec(CANCELLED_OPS_TABLE)
			this.#created = true
		}
		return this.#sql
	}

	isCancelled(operationId: string): boolean {
		const rows = [
			...this.#table().exec(
				"SELECT 1 FROM checkfu_cancelled_ops WHERE operation_id = ? LIMIT 1",
				operationId,
			),
		]
		return rows.length > 0
	}

	markCancelled(operationId: string): void {
		this.#table().exec(
			"INSERT OR IGNORE INTO checkfu_cancelled_ops (operation_id) VALUES (?)",
			operationId,
		)
	}
}
