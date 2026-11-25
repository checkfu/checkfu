import { withCancel } from "@earendil-works/chord/context"
import type { Context } from "@earendil-works/chord/context"
import type { CodemodeSandboxBase } from "@earendil-works/pi-codemode/portable"
import { CODEMODE_OPTIONS_PREFIX, parseCodemodeSource } from "@earendil-works/pi-codemode/source"
import { LiveDoc } from "@earendil-works/pi-durable"
import type {
	TaskId,
	ToolExecutionApi,
	ToolExecutionResult,
	ToolRegistration,
} from "@earendil-works/pi-durable"
import { createCodemodeTool } from "@earendil-works/pi-durable/codemode"
import * as Effect from "effect/Effect"
import { ACTION_MEMO } from "./PiActions.ts"
import { SCRIPT_DEADLINE } from "./PiCodemode.ts"
import type { ScriptDeadline } from "./PiCodemode.ts"
import { asExecuteTool } from "./PiExecuteTool.ts"

export interface ScriptBudget {
	readonly code: string
	readonly budgetMs: number
}

export const scriptBudget = (
	source: string,
	{ defaultMs, maxMs }: ScriptDeadline = SCRIPT_DEADLINE,
): ScriptBudget => {
	let parsed: ReturnType<typeof parseCodemodeSource>
	try {
		parsed = parseCodemodeSource(source)
	} catch {
		return { code: source, budgetMs: maxMs }
	}
	const { maxOutputTokens, timeoutMs } = parsed.options
	const budgetMs = Math.min(timeoutMs ?? defaultMs, maxMs)
	if (timeoutMs === undefined) {
		return { code: source, budgetMs }
	}
	const code =
		maxOutputTokens === undefined
			? parsed.code
			: `${CODEMODE_OPTIONS_PREFIX} ${JSON.stringify({ max_output_tokens: maxOutputTokens })}${parsed.code}`
	return { code, budgetMs }
}

const ranOf = (checkpoint: unknown): number =>
	typeof checkpoint === "object" &&
	checkpoint !== null &&
	"ranMs" in checkpoint &&
	typeof checkpoint.ranMs === "number"
		? checkpoint.ranMs
		: 0

const sourceOf = (args: unknown): string =>
	typeof args === "object" && args !== null && "code" in args && typeof args.code === "string"
		? args.code
		: ""

type AttemptEnd =
	| { readonly kind: "done"; readonly result: ToolExecutionResult }
	| { readonly kind: "parked"; readonly on: ReadonlyArray<TaskId> }

type ScriptCall =
	| { readonly at: "issued" }
	| { readonly at: "admitting" }
	| { readonly at: "tracked"; readonly taskId: TaskId }
	| { readonly at: "settled" }

export class ScriptCalls {
	private readonly calls: Array<ScriptCall> = []
	private parked: ReadonlyArray<TaskId> | undefined
	private checking = false
	private recheck = false
	private readonly waitsForPerson: (id: TaskId) => Promise<boolean>
	private readonly park: (on: ReadonlyArray<TaskId>) => void

	constructor(
		waitsForPerson: (id: TaskId) => Promise<boolean>,
		park: (on: ReadonlyArray<TaskId>) => void,
	) {
		this.waitsForPerson = waitsForPerson
		this.park = park
	}

	get parkedOn(): ReadonlyArray<TaskId> | undefined {
		return this.parked
	}

	issue(): void {
		this.calls.push({ at: "issued" })
	}

	async through<C extends { readonly taskId: TaskId }, A>(
		admit: () => Promise<C>,
		result: (call: C) => Promise<A>,
	): Promise<A> {
		const issued = this.calls.findIndex((call) => call.at === "issued")
		const at = issued === -1 ? this.calls.length : issued
		this.calls[at] = { at: "admitting" }
		try {
			const call = await admit()
			this.calls[at] = { at: "tracked", taskId: call.taskId }
			void this.check()
			return await result(call)
		} finally {
			this.calls[at] = { at: "settled" }
			void this.check()
		}
	}

	async check(): Promise<void> {
		if (this.parked !== undefined) {
			return
		}
		if (this.checking) {
			this.recheck = true
			return
		}
		this.checking = true
		try {
			do {
				this.recheck = false
				await this.checkOnce()
			} while (this.recheck && this.parked === undefined)
		} catch {
			this.recheck = false
		} finally {
			this.checking = false
		}
	}

	private unsettled(): ReadonlyArray<TaskId> | undefined {
		const tasks: Array<TaskId> = []
		for (const call of this.calls) {
			if (call.at === "issued" || call.at === "admitting") {
				return undefined
			}
			if (call.at === "tracked") {
				tasks.push(call.taskId)
			}
		}
		return tasks
	}

	private async checkOnce(): Promise<void> {
		const waiting = this.unsettled()
		if (waiting === undefined || waiting.length === 0) {
			return
		}
		for (const id of waiting) {
			if (!(await this.waitsForPerson(id))) {
				return
			}
		}
		const now = this.unsettled()
		if (
			now === undefined ||
			now.length !== waiting.length ||
			now.some((id, index) => id !== waiting[index])
		) {
			this.recheck = true
			return
		}
		this.parked = waiting
		this.park(waiting)
	}
}

class ScriptRun {
	private readonly calls: ScriptCalls
	private readonly inner: Context

	private readonly api: ToolExecutionApi
	private readonly remainingMs: number

	constructor(api: ToolExecutionApi, context: Context, remainingMs: number) {
		this.api = api
		this.remainingMs = remainingMs
		const { context: inner, cancel } = withCancel(context)
		this.inner = inner
		this.calls = new ScriptCalls(
			async (id) => {
				const task = await api.getTask(id, inner)
				return (
					task !== undefined &&
					task.state.status === "sleeping" &&
					task.memos?.[ACTION_MEMO] !== undefined
				)
			},
			() => cancel(new Error("The script waits for a person")),
		)
	}

	async run(sandbox: () => CodemodeSandboxBase, code: string): Promise<AttemptEnd> {
		const watch = await this.api
			.watchDoc(LiveDoc, this.api.conversationId, this.inner)
			.catch(() => undefined)
		watch?.start(() => this.calls.check())
		const tool = createCodemodeTool({ sandbox: this.watched(sandbox()), models: false })
		try {
			const result = await tool.execute({ code }, this.tracked(), this.inner)
			if ("sleep" in result || "wait" in result) {
				throw new Error("Pi's code mode parked on its own")
			}
			return { kind: "done", result }
		} catch (error) {
			const on = this.calls.parkedOn
			if (on !== undefined) {
				return { kind: "parked", on }
			}
			throw error
		} finally {
			void watch?.stop()
		}
	}

	private watched(sandbox: CodemodeSandboxBase): CodemodeSandboxBase {
		const start = sandbox.start.bind(sandbox)
		sandbox.start = (code, options) =>
			start(code, {
				...options,
				timeoutMs: this.remainingMs,
				onCall: (call) => {
					if (call.target === "tool") {
						this.calls.issue()
					}
					options.onCall(call)
				},
				onIdle: (seq, issued) => {
					options.onIdle?.(seq, issued)
					void this.calls.check()
				},
			})
		return sandbox
	}

	private tracked(): ToolExecutionApi {
		const api = this.api
		const executeTool = (
			name: string,
			args: Parameters<ToolExecutionApi["executeTool"]>[1],
			context: Context,
			options?: { readonly key?: string; readonly progress?: boolean },
		) =>
			this.calls.through(
				() => api.executeTool(name, args, context, { ...options, wait: false }),
				(call) => call.result(context),
			)
		return { ...api, executeTool: asExecuteTool(executeTool) }
	}
}

export const durableCodemodeTool = (
	sandbox: () => CodemodeSandboxBase,
	deadline: ScriptDeadline = SCRIPT_DEADLINE,
): ToolRegistration => {
	const pi = createCodemodeTool({ sandbox: sandbox(), models: false })
	return {
		...pi,
		execute: async (args, api, context) => {
			const { code, budgetMs } = scriptBudget(sourceOf(args), deadline)
			const ranMs = ranOf(api.checkpoint)
			const remainingMs = budgetMs - ranMs
			if (remainingMs <= 0) {
				return {
					output: [
						{
							type: "text",
							text: `Script timed out: it ran for ${budgetMs} ms, not counting waits.`,
						},
					],
					isError: true,
				}
			}
			const began = api.now()
			const end = await new ScriptRun(api, context, remainingMs).run(sandbox, code)
			if (end.kind === "done") {
				return end.result
			}
			Effect.runSync(
				Effect.logInfo("Script parked; its sandbox run has ended", { waiting_on: end.on.length }),
			)
			return {
				wait: { on: end.on, policy: "any", checkpoint: { ranMs: ranMs + (api.now() - began) } },
			}
		},
	}
}
