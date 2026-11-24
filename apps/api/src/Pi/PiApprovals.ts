import type { TextBlock, ToolCall } from "@checkfu/domain/Session/SessionTypes"
import type { ToolCallAwaits } from "@checkfu/domain/Session/ToolConfirmation.aggregate"
import { ToolTask, defineSignal, hook } from "@earendil-works/pi-durable"
import type { Extension, SignalResult, TaskId } from "@earendil-works/pi-durable"
import { bool, obj, str } from "@earendil-works/pi-schema"
import * as Schema from "effect/Schema"
import type { McpCall, McpCallResult, SqlExecutor } from "./PiMcpStore.ts"
import type { PiToolAnswer, PiToolDecision, PiToolResult } from "./PiTurn.ts"

export const APPROVALS_EXTENSION = "checkfu.approvals"

/** A person's answer to one waiting tool call, delivered to the call itself. */
export const ToolDecision = defineSignal({
	name: "checkfu.tool-decision",
	version: 1,
	schema: obj({ allow: bool(), message: str() }),
})
export const TOOL_DECISION_KEY = "decision"

export type ToolDecisionValue = typeof PiToolDecision.Type

export type ToolResultValue = typeof PiToolResult.Type

export type ToolAnswer = typeof PiToolAnswer.Type

export const DENIED_MESSAGE = "This tool call was not approved."
export const NO_RESULT_MESSAGE = "This tool call was given no result."

export const scriptBlockedMessage = (tool: string): string =>
	`${tool} needs a person's approval, which a script cannot wait for. It did not run. Call ${tool} directly, outside a script (load it with tool_search first if it is not offered yet).`

const WaitingRow = Schema.Struct({
	tool_use_id: Schema.String,
	task_id: Schema.Finite,
	operation_id: Schema.String,
	awaits: Schema.Literals(["confirmation", "result"]),
	answered: Schema.Finite,
})
const decodeWaitingRow = Schema.decodeUnknownSync(WaitingRow)
const TextRow = Schema.Struct({ value: Schema.String })
const decodeTextRow = Schema.decodeUnknownSync(TextRow)

export interface WaitingCall {
	readonly tool_use_id: string
	readonly task_id: number
	readonly operation_id: string
	readonly awaits: ToolCallAwaits
	readonly answered: boolean
}

/**
 * What a session object remembers about tool calls that wait for a person.
 * A parked call holds no process, so everything needed to pause the turn,
 * find the call again after an eviction and carry on from an answer is here.
 */
export class PiApprovalStore {
	readonly #sql: SqlExecutor
	#initialized = false

	constructor(sql: SqlExecutor) {
		this.#sql = sql
	}

	#ready(): void {
		if (!this.#initialized) {
			this.#sql.transaction(() => {
				this.#sql.exec(
					"CREATE TABLE IF NOT EXISTS checkfu_waiting_calls (tool_use_id TEXT PRIMARY KEY, task_id INTEGER NOT NULL, operation_id TEXT NOT NULL, awaits TEXT NOT NULL, answered INTEGER NOT NULL DEFAULT 0)",
				)
				this.#sql.exec(
					"CREATE TABLE IF NOT EXISTS checkfu_resumed_turns (turn_operation_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL)",
				)
				this.#sql.exec(
					"CREATE TABLE IF NOT EXISTS checkfu_published_tool_events (event_key TEXT PRIMARY KEY, turn_operation_id TEXT NOT NULL)",
				)
				this.#sql.exec(
					"CREATE TABLE IF NOT EXISTS checkfu_active_operation (id INTEGER PRIMARY KEY CHECK (id = 1), operation_id TEXT NOT NULL)",
				)
			})
			this.#initialized = true
		}
	}

	#exec(query: string, ...bindings: ReadonlyArray<unknown>): Array<object> {
		this.#ready()
		return [...this.#sql.exec(query, ...bindings)]
	}

	/** The operation Pi is running: the one a call that parks now belongs to. */
	activeOperation(): string | null {
		const row = this.#exec("SELECT operation_id AS value FROM checkfu_active_operation")[0]
		return row === undefined ? null : decodeTextRow(row).value
	}

	/** A new operation starts: whatever waited under an earlier one is over. */
	begin(operationId: string): void {
		this.#ready()
		this.#sql.transaction(() => {
			this.#exec("DELETE FROM checkfu_waiting_calls")
			this.#exec("DELETE FROM checkfu_resumed_turns")
			this.#exec("DELETE FROM checkfu_published_tool_events")
			this.#exec(
				"INSERT INTO checkfu_active_operation (id, operation_id) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET operation_id = excluded.operation_id",
				operationId,
			)
		})
	}

	parked(call: {
		readonly tool_use_id: string
		readonly task_id: number
		readonly awaits: ToolCallAwaits
	}): void {
		this.#exec(
			"INSERT OR IGNORE INTO checkfu_waiting_calls (tool_use_id, task_id, operation_id, awaits) VALUES (?, ?, ?, ?)",
			call.tool_use_id,
			call.task_id,
			this.activeOperation() ?? "",
			call.awaits,
		)
	}

	calls(): Array<WaitingCall> {
		return this.#exec(
			"SELECT tool_use_id, task_id, operation_id, awaits, answered FROM checkfu_waiting_calls ORDER BY rowid",
		).map((row) => {
			const call = decodeWaitingRow(row)
			return { ...call, answered: call.answered === 1 }
		})
	}

	answered(toolUseId: string): void {
		this.#exec("UPDATE checkfu_waiting_calls SET answered = 1 WHERE tool_use_id = ?", toolUseId)
	}

	/** The call ran, was denied or was stopped: it waits for nobody any more. */
	settled(toolUseId: string): void {
		this.#exec("DELETE FROM checkfu_waiting_calls WHERE tool_use_id = ?", toolUseId)
	}

	forgetWaiting(): void {
		this.#exec("DELETE FROM checkfu_waiting_calls")
	}

	/** The operation whose calls wait, when a turn other than the one that started it asks. */
	pausedOperation(): string | null {
		const row = this.#exec(
			"SELECT operation_id AS value FROM checkfu_waiting_calls ORDER BY rowid LIMIT 1",
		)[0]
		return row === undefined ? null : decodeTextRow(row).value
	}

	/** The paused operation a later turn carries on, once that turn has taken it up. */
	resumedBy(turnOperationId: string): string | null {
		const row = this.#exec(
			"SELECT operation_id AS value FROM checkfu_resumed_turns WHERE turn_operation_id = ?",
			turnOperationId,
		)[0]
		return row === undefined ? null : decodeTextRow(row).value
	}

	resume(turnOperationId: string, operationId: string): void {
		this.#exec(
			"INSERT OR IGNORE INTO checkfu_resumed_turns (turn_operation_id, operation_id) VALUES (?, ?)",
			turnOperationId,
			operationId,
		)
	}

	forgetResumed(turnOperationId: string): void {
		this.#exec("DELETE FROM checkfu_resumed_turns WHERE turn_operation_id = ?", turnOperationId)
	}

	/**
	 * The calls a turn has yet to publish. One operation can span several
	 * turns, each pausing where the last one's answers took it; a call's use
	 * and its result each belong to the first turn that saw them, however often
	 * that turn asks. A call whose use an earlier turn published is published
	 * as its result alone.
	 */
	unpublished(turnOperationId: string, calls: ReadonlyArray<ToolCall>): Array<ToolCall> {
		const mine: Array<ToolCall> = []
		this.#ready()
		const claim = (key: string): boolean => {
			this.#exec(
				"INSERT OR IGNORE INTO checkfu_published_tool_events (event_key, turn_operation_id) VALUES (?, ?)",
				key,
				turnOperationId,
			)
			const row = this.#exec(
				"SELECT turn_operation_id AS value FROM checkfu_published_tool_events WHERE event_key = ?",
				key,
			)[0]
			return row !== undefined && decodeTextRow(row).value === turnOperationId
		}
		this.#sql.transaction(() => {
			for (const call of calls) {
				if (call._tag === "result") {
					if (claim(`result:${call.result.tool_use_id}`)) {
						mine.push(call)
					}
					continue
				}
				const usedHere = claim(`use:${call.use.tool_use_id}`)
				if (call._tag === "use") {
					if (usedHere) {
						mine.push(call)
					}
					continue
				}
				const answeredHere = claim(`result:${call.result.tool_use_id}`)
				if (usedHere) {
					mine.push(answeredHere ? call : { _tag: "use", use: call.use })
				} else if (answeredHere) {
					mine.push({ _tag: "result", result: call.result })
				}
			}
		})
		return mine
	}
}

interface GatedTool {
	readonly server: string
	readonly tool: string
	readonly ask: boolean
}

export interface ToolGateOptions {
	readonly store: PiApprovalStore
	/** How a tool is let through, by the name the model calls it; undefined for a tool that never asks. */
	readonly permission: (toolName: string) => GatedTool | undefined
	readonly ledger: {
		readonly began: (call: McpCall) => void
		readonly ended: (callId: string, result: McpCallResult) => void
	}
	readonly signal: (
		taskId: TaskId,
		value: { readonly allow: boolean; readonly message: string },
	) => Promise<SignalResult>
	/** Hands a result to a call that parked itself to wait for one. */
	readonly signalResult: (
		taskId: TaskId,
		value: { readonly content: ReadonlyArray<TextBlock>; readonly is_error: boolean },
	) => Promise<SignalResult>
}

// Calls of one round reach the gate one after another; a pause is declared once they all have.
const PAUSE_SETTLE_MS = 50

const isJsonObject = Schema.is(Schema.JsonObject)
const isTaskId = (value: number): value is TaskId => Number.isSafeInteger(value)

type Settled =
	| { readonly status: "done" }
	| { readonly status: "unanswered"; readonly reason?: string }

/**
 * Holds tool calls that need a person's approval. A call the model made parks
 * until the answer arrives, holding no process. A call a script made is
 * refused at once: a script waits in memory, so it is told to let the model
 * make the call itself. Pi runs the gate again on every wake and reopen, so
 * each pass reads the answer afresh and repeats nothing.
 */
export const makeToolGate = ({
	store,
	permission,
	ledger,
	signal,
	signalResult,
}: ToolGateOptions) => {
	const executing = new Set<string>()
	let listeners = new Set<() => void>()
	let timer: ReturnType<typeof setTimeout> | undefined

	const waiting = (awaits?: ToolCallAwaits): Array<string> =>
		store
			.calls()
			.filter((call) => !call.answered && (awaits === undefined || call.awaits === awaits))
			.map((call) => call.tool_use_id)

	// Nothing runs and nothing is on its way: every call left is one a person has yet to answer.
	const onlyWaits = (): boolean => {
		const calls = store.calls()
		return calls.length > 0 && calls.every((call) => !call.answered) && executing.size === 0
	}

	const check = () => {
		timer ??= setTimeout(() => {
			timer = undefined
			if (listeners.size > 0 && onlyWaits()) {
				const notify = listeners
				listeners = new Set()
				for (const resume of notify) {
					resume()
				}
			}
		}, PAUSE_SETTLE_MS)
	}

	const extension: Extension = {
		name: APPROVALS_EXTENSION,
		hooks: [
			hook(ToolTask, {
				beforeTool: async (call, api, context) => {
					const target = permission(call.name)
					if (target === undefined || !target.ask) {
						executing.add(call.id)
						return undefined
					}
					ledger.began({
						call_id: call.id,
						server: target.server,
						tool: target.tool,
						input: isJsonObject(call.arguments) ? call.arguments : {},
						permission: "ask",
					})
					if (call.parent !== undefined) {
						const message = scriptBlockedMessage(call.name)
						ledger.ended(call.id, { content: [{ type: "text", text: message }], is_error: true })
						return { block: message }
					}
					const decision = await api.readSignal(ToolDecision, TOOL_DECISION_KEY, context)
					if (decision === undefined) {
						store.parked({ tool_use_id: call.id, task_id: api.taskId, awaits: "confirmation" })
						check()
						return { sleep: { signals: [ToolDecision.key(TOOL_DECISION_KEY)] } }
					}
					store.settled(call.id)
					if ("value" in decision && decision.value.allow) {
						executing.add(call.id)
						return undefined
					}
					return {
						block:
							"value" in decision && decision.value.message !== ""
								? decision.value.message
								: DENIED_MESSAGE,
					}
				},
				afterTool: (call) => {
					store.settled(call.id)
					executing.delete(call.id)
					check()
					return undefined
				},
			}),
		],
	}

	return {
		extension,
		waiting: () => waiting(),
		/** Those of `waiting` that wait for a result from the caller's application. */
		waitingResults: () => waiting("result"),
		/**
		 * A tool that waits for its result from outside parks itself; the turn
		 * pauses on it as it does on a call that waits for a person.
		 */
		park: (call: { readonly tool_use_id: string; readonly task_id: number }) => {
			store.parked({ ...call, awaits: "result" })
			executing.delete(call.tool_use_id)
			check()
		},
		/** Hands each answer to its parked call. An answer for a call that is gone is dropped. */
		deliver: async (answers: ReadonlyArray<ToolAnswer>): Promise<void> => {
			for (const answer of answers) {
				const call = store.calls().find((row) => row.tool_use_id === answer.tool_use_id)
				if (call === undefined || call.answered || !isTaskId(call.task_id)) {
					continue
				}
				// A result is no answer to a call that waits for a person; a denial ends a wait for a result as a failure.
				const delivery =
					call.awaits === "confirmation"
						? "allow" in answer
							? signal(call.task_id, { allow: answer.allow, message: answer.message })
							: undefined
						: signalResult(
								call.task_id,
								"content" in answer
									? { content: answer.content, is_error: answer.is_error }
									: {
											content: [
												{
													type: "text",
													text: answer.message === "" ? NO_RESULT_MESSAGE : answer.message,
												},
											],
											is_error: true,
										},
							)
				if (delivery === undefined) {
					continue
				}
				const result = await delivery
				if (result === "delivered" || result === "duplicate") {
					store.answered(call.tool_use_id)
				} else {
					store.settled(call.tool_use_id)
				}
			}
		},
		/**
		 * `wait`, or sooner: once the operation has nothing left to do but wait
		 * for answers. The operation itself goes on waiting in Pi.
		 */
		settleOrPause: async (
			wait: (signal: AbortSignal) => Promise<Settled>,
			outer?: AbortSignal,
		): Promise<
			Settled | { readonly status: "paused"; readonly waiting: ReadonlyArray<string> }
		> => {
			const stop = new AbortController()
			const abort = () => {
				stop.abort()
			}
			outer?.addEventListener("abort", abort, { once: true })
			let pausedListener: (() => void) | undefined
			const paused = new Promise<void>((resolve) => {
				pausedListener = resolve
				listeners.add(resolve)
			})
			check()
			const settled = wait(stop.signal)
			try {
				return await Promise.race([
					settled,
					paused.then(() => ({ status: "paused" as const, waiting: waiting() })),
				])
			} finally {
				if (pausedListener !== undefined) {
					listeners.delete(pausedListener)
				}
				outer?.removeEventListener("abort", abort)
				// The wait is given up, not the work; its rejection has nobody left to tell.
				settled.catch(() => undefined)
				stop.abort()
			}
		},
	}
}

export type ToolGate = ReturnType<typeof makeToolGate>
