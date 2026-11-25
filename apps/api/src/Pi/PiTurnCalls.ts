import { MAX_TOOL_CALLS_PER_TURN } from "@checkfu/domain/Session/SessionTypes"
import type { TurnCalls } from "@checkfu/domain/Session/ToolEventBounds"
import * as Schema from "effect/Schema"
import type { SqlExecutor } from "./TurnFence.ts"

export const TURN_CALLS_TABLE =
	"CREATE TABLE IF NOT EXISTS checkfu_turn_calls (turn INTEGER NOT NULL, task_id INTEGER NOT NULL, PRIMARY KEY (turn, task_id))"

const Counted = Schema.Struct({ calls: Schema.Int })
const Placed = Schema.Struct({ task_id: Schema.Int })
const decodeCounted = Schema.decodeUnknownSync(Counted)
const decodePlaced = Schema.decodeUnknownSync(Placed)

export const turnCallLog = (sql: SqlExecutor): ((turn: number) => TurnCalls) => {
	let created = false
	const table = (): SqlExecutor => {
		if (!created) {
			sql.exec(TURN_CALLS_TABLE)
			created = true
		}
		return sql
	}
	return (turn) => ({
		admit: (taskId) => {
			const placed = table().exec(
				"SELECT task_id FROM checkfu_turn_calls WHERE turn = ? AND task_id = ?",
				turn,
				taskId,
			)
			if ([...placed].length > 0) {
				return true
			}
			const [counted] = table().exec(
				"SELECT COUNT(*) AS calls FROM checkfu_turn_calls WHERE turn = ?",
				turn,
			)
			if (decodeCounted(counted).calls >= MAX_TOOL_CALLS_PER_TURN) {
				return false
			}
			table().exec(
				"INSERT OR IGNORE INTO checkfu_turn_calls (turn, task_id) VALUES (?, ?)",
				turn,
				taskId,
			)
			return true
		},
		admitted: () =>
			[
				...table().exec(
					"SELECT task_id FROM checkfu_turn_calls WHERE turn = ? ORDER BY task_id",
					turn,
				),
			].map((row) => decodePlaced(row).task_id),
	})
}

export type TurnCallLog = ReturnType<typeof turnCallLog>
