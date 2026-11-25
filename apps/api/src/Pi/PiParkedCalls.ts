import {
	MAX_TOOL_RESULT_TEXT_LENGTH,
	TextBlock,
	ToolRejection,
} from "@checkfu/domain/Session/SessionTypes"
import type { ParkedCall } from "@checkfu/domain/Session/ToolEventBounds"
import { truncateText } from "@checkfu/domain/Session/TextBounds"
import { ToolTask, defineExtension, hook } from "@earendil-works/pi-durable"
import type { Extension, ToolExecutionResult } from "@earendil-works/pi-durable"
import * as Schema from "effect/Schema"
import { ACTION_MEMO } from "./PiActions.ts"
import { rejectionIn } from "./PiRejection.ts"
import type { SqlExecutor } from "./TurnFence.ts"

const ParkedCallRow = Schema.Struct({
	task_id: Schema.Int,
	name: Schema.String,
	content: Schema.fromJsonString(Schema.Array(TextBlock)),
	content_truncated: Schema.Int,
	is_error: Schema.Int,
	rejected: Schema.NullOr(ToolRejection),
})

const decodeRow = Schema.decodeUnknownSync(ParkedCallRow)

export const PARKED_CALLS_TABLE =
	"CREATE TABLE IF NOT EXISTS checkfu_parked_calls (turn INTEGER NOT NULL, task_id INTEGER NOT NULL, script_task_id INTEGER NOT NULL, name TEXT NOT NULL, content TEXT NOT NULL, content_truncated INTEGER NOT NULL, is_error INTEGER NOT NULL, rejected TEXT, PRIMARY KEY (turn, task_id))"

export interface ParkedCalls {
	readonly record: (call: ParkedCall & { readonly script_task_id: number }) => void
	readonly forScript: (scriptTaskId: number) => ReadonlyArray<ParkedCall>
}

export const parkedCallLog = (sql: SqlExecutor): ((turn: number) => ParkedCalls) => {
	let created = false
	const table = (): SqlExecutor => {
		if (!created) {
			sql.exec(PARKED_CALLS_TABLE)
			created = true
		}
		return sql
	}
	return (turn) => ({
		record: (call) => {
			table().exec(
				"INSERT OR IGNORE INTO checkfu_parked_calls (turn, task_id, script_task_id, name, content, content_truncated, is_error, rejected) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				turn,
				call.task_id,
				call.script_task_id,
				call.name,
				JSON.stringify(call.content),
				call.content_truncated === true ? 1 : 0,
				call.is_error ? 1 : 0,
				call.rejected ?? null,
			)
		},
		forScript: (scriptTaskId) =>
			[
				...table().exec(
					"SELECT task_id, name, content, content_truncated, is_error, rejected FROM checkfu_parked_calls WHERE turn = ? AND script_task_id = ? ORDER BY task_id",
					turn,
					scriptTaskId,
				),
			].map((raw) => {
				const row = decodeRow(raw)
				return {
					task_id: row.task_id,
					name: row.name,
					content: row.content,
					is_error: row.is_error === 1,
					...(row.content_truncated === 1 ? { content_truncated: true as const } : {}),
					...(row.rejected === null ? {} : { rejected: row.rejected }),
				}
			}),
	})
}

export type ParkedCallLog = ReturnType<typeof parkedCallLog>

const contentOf = (output: ToolExecutionResult["output"]) => {
	let room = MAX_TOOL_RESULT_TEXT_LENGTH
	let truncated = false
	const content: Array<TextBlock> = []
	for (const item of output ?? []) {
		const full = item.type === "text" ? item.text : `[${item.mimeType} image]`
		const text = truncateText(full, room)
		truncated ||= text.length < full.length
		room -= text.length
		if (text.length > 0) {
			content.push({ type: "text", text })
		}
	}
	return { content, truncated }
}

export const parkedCallsExtension = (log: Pick<ParkedCalls, "record">): Extension =>
	defineExtension({
		name: "checkfu.parked-calls",
		hooks: [
			hook(ToolTask, {
				afterTool: async (call, result, api, context) => {
					if (call.parent === undefined || (await api.memo(ACTION_MEMO, context)) === undefined) {
						return undefined
					}
					const { content, truncated } = contentOf(result.output)
					const rejected = rejectionIn(result.details)
					log.record({
						task_id: api.taskId,
						script_task_id: call.parent.taskId,
						name: call.name,
						content,
						is_error: result.isError === true,
						...(truncated ? { content_truncated: true as const } : {}),
						...(rejected === undefined ? {} : { rejected }),
					})
					return undefined
				},
			}),
		],
	})
