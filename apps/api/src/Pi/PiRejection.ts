import type { ToolRejection } from "@checkfu/domain/Session/SessionTypes"
import { LiveDoc, ToolTask, defineExtension, hook } from "@earendil-works/pi-durable"
import type { Context } from "@earendil-works/chord/context"
import type { JsonValue } from "@earendil-works/chord/json"
import type { HookApi, LiveState, TaskId, ToolExecutionResult } from "@earendil-works/pi-durable"

type Diagnostics = NonNullable<ToolExecutionResult["diagnostics"]>

export const REJECTED_KEY = "checkfu.rejected"

const rejectionOfCode = (code: string | undefined): ToolRejection | undefined =>
	code === "tool_unavailable"
		? "unavailable"
		: code === "invalid_arguments" || code === "blocked"
			? code
			: undefined

const isObject = (value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } =>
	typeof value === "object" && value !== null && !Array.isArray(value)

export const rejectionIn = (details: unknown): ToolRejection | undefined => {
	if (typeof details !== "object" || details === null || !(REJECTED_KEY in details)) {
		return undefined
	}
	const marked = details[REJECTED_KEY]
	return marked === "unavailable" || marked === "invalid_arguments" || marked === "blocked"
		? marked
		: undefined
}

const reasonIn = (diagnostics: Diagnostics): ToolRejection | undefined => {
	for (const diagnostic of diagnostics) {
		const rejected = diagnostic.severity === "error" ? rejectionOfCode(diagnostic.code) : undefined
		if (rejected !== undefined) {
			return rejected
		}
	}
	return undefined
}

export const ranFromSlot = (
	live: Readonly<LiveState> | undefined,
	taskId: TaskId,
): boolean | undefined => {
	const slot = [...(live?.tools ?? []), ...(live?.nestedTools ?? [])].find(
		(each) => each.taskId === taskId,
	)
	if (slot?.status === "running" || slot?.status === "waiting") {
		return true
	}
	return slot?.status === "pending" ? false : undefined
}

const BLOCKED_AT_GATE = "checkfu.blocked-at-gate"

export const blockAtGate = async (
	api: HookApi,
	message: string,
	context: Context,
): Promise<{ readonly block: string }> => {
	await api.memo(BLOCKED_AT_GATE, true, context)
	return { block: message }
}

const withoutMark = (details: JsonValue | undefined): JsonValue | undefined => {
	if (!isObject(details) || !(REJECTED_KEY in details)) {
		return details
	}
	const { [REJECTED_KEY]: _forged, ...rest } = details
	return rest
}

export const markRejection = (
	result: ToolExecutionResult,
	ran: boolean | undefined,
): ToolExecutionResult => {
	const details = withoutMark(result.details)
	const reason = ran === false ? reasonIn(result.diagnostics ?? []) : undefined
	if (reason !== undefined && (details === undefined || isObject(details))) {
		return { ...result, details: { ...details, [REJECTED_KEY]: reason } }
	}
	if (details === result.details) {
		return result
	}
	const { details: _unmarked, ...rest } = result
	return details === undefined ? rest : { ...rest, details }
}

export const rejectionProvenanceExtension = defineExtension({
	name: "checkfu.rejection-provenance",
	hooks: [
		hook(ToolTask, {
			afterTool: async (_call, result, api, context) => {
				const named = reasonIn(result.diagnostics ?? []) !== undefined
				const ran = named
					? (ranFromSlot(await api.snapshot(LiveDoc, api.conversationId, context), api.taskId) ??
						((await api.memo<boolean>(BLOCKED_AT_GATE, context)) === true ? false : undefined))
					: undefined
				const marked = markRejection(result, ran)
				return marked === result ? undefined : marked
			},
		}),
	],
})
