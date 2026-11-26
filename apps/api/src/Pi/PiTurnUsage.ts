import type { ModelUsage } from "@checkfu/domain/Session/SessionTypes"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { ROOT_CONVERSATION_ID, UsageDoc } from "@earendil-works/pi-durable"
import type { Harness, Tx } from "@earendil-works/pi-durable"
import {
	ACTIVE_USAGE_DOC_VERSION,
	ActiveUsage,
	ActiveUsageState,
	CHECKFU_PI_DOCS,
	SETTLED_USAGE_DOC_VERSION,
	SettledUsage,
	SettledUsageState,
} from "./PiDocRegistry.ts"
import type { CheckfuPiDocSpec } from "./PiDocRegistry.ts"

export {
	ACTIVE_USAGE_DOC_VERSION,
	ActiveUsage,
	ActiveUsageState,
	CHECKFU_PI_DOCS,
	type CheckfuPiDocSpec,
	SETTLED_USAGE_DOC_VERSION,
	SettledUsage,
	SettledUsageState,
}

const totalUsage = async (tx: Tx): Promise<ModelUsage> => {
	const ledger = await tx.doc(UsageDoc, ROOT_CONVERSATION_ID)
	let input_tokens = 0
	let output_tokens = 0
	for (const usage of Object.values(ledger.models)) {
		input_tokens += usage.input + usage.cacheRead + usage.cacheWrite
		output_tokens += usage.output
	}
	return { input_tokens, output_tokens }
}

const closeUsage = async (tx: Tx, operation: string, start: ModelUsage, end: ModelUsage) => {
	const usage = await tx.doc(SettledUsage, operation, {
		input_tokens: end.input_tokens - start.input_tokens,
		output_tokens: end.output_tokens - start.output_tokens,
	})
	return { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens }
}

export type BeginTurnUsageResult =
	| { readonly status: "ready" }
	| { readonly status: "waiting"; readonly operationId: string }
	| { readonly status: "finalize"; readonly operationId: string }
	| { readonly status: "stale" }

export const beginTurnUsage = (
	pi: Harness,
	operation: string,
	turn: number,
	finalizedPrevious?: string,
): Promise<BeginTurnUsageResult> =>
	pi.commit(async (tx) => {
		const active = await tx.doc(ActiveUsage)
		if (active.operation === operation) {
			return { status: "ready" as const }
		}
		if (turn < active.turn) {
			return { status: "stale" as const }
		}
		const previousOperation = active.operation
		const previous =
			previousOperation === null
				? undefined
				: await tx.submissionByRequest(ROOT_CONVERSATION_ID, previousOperation)
		if (
			previousOperation !== null &&
			(previous?.status === "queued" || previous?.status === "placed")
		) {
			return { status: "waiting" as const, operationId: previousOperation }
		}
		if (
			previousOperation !== null &&
			previous !== undefined &&
			finalizedPrevious !== previousOperation
		) {
			return { status: "finalize" as const, operationId: previousOperation }
		}
		const total = await totalUsage(tx)
		if (previousOperation !== null && previous !== undefined) {
			await closeUsage(tx, previousOperation, active, total)
		}
		active.operation = operation
		active.turn = turn
		active.input_tokens = total.input_tokens
		active.output_tokens = total.output_tokens
		return { status: "ready" as const }
	}, BACKGROUND_CONTEXT)

export const settleTurnUsage = async (pi: Harness, operation: string): Promise<ModelUsage> => {
	const closed = await pi.commit(async (tx) => {
		const active = await tx.doc(ActiveUsage)
		if (active.operation !== operation) {
			return undefined
		}
		const usage = await closeUsage(tx, operation, active, await totalUsage(tx))
		active.operation = null
		return usage
	}, BACKGROUND_CONTEXT)
	if (closed !== undefined) {
		return closed
	}
	const saved = await pi.snapshot(SettledUsage, operation, BACKGROUND_CONTEXT)
	if (saved === undefined) {
		throw new Error("Missing Pi operation usage receipt")
	}
	return saved
}
