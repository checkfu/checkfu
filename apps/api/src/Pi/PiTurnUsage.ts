import type { ModelUsage } from "@checkfu/sessions/Session/SessionTypes"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { type Harness, ROOT_CONVERSATION_ID, type Tx, UsageDoc } from "@earendil-works/pi-durable"
import {
	ACTIVE_USAGE_DOC_VERSION,
	ActiveUsage,
	ActiveUsageState,
	CHECKFU_PI_DOCS,
	type CheckfuPiDocSpec,
	SEED_STATE_DOC_VERSION,
	SETTLED_USAGE_DOC_VERSION,
	SeedState,
	SeedStateValue,
	SettledUsage,
	SettledUsageState,
} from "./PiDocRegistry.ts"

export {
	ACTIVE_USAGE_DOC_VERSION,
	ActiveUsage,
	ActiveUsageState,
	CHECKFU_PI_DOCS,
	type CheckfuPiDocSpec,
	SEED_STATE_DOC_VERSION,
	SETTLED_USAGE_DOC_VERSION,
	SeedState,
	SeedStateValue,
	SettledUsage,
	SettledUsageState,
}

export const clearSeedRebuild = async (pi: Harness): Promise<void> => {
	const current = await pi.snapshot(SeedState, BACKGROUND_CONTEXT)
	if (current?.rebuildRequired !== true) return
	await pi.commit(async (tx) => {
		const seedState = await tx.doc(SeedState)
		seedState.rebuildRequired = false
		seedState.seededByOperation = null
	}, BACKGROUND_CONTEXT)
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
	| { readonly status: "history_required" }
	| { readonly status: "rebuild" }

// If a different operation is still working, wait for it outside the admission lock.
// If it settled after losing its RPC waiter, finalize its context cleanup before
// sealing its usage, checking whether a trimmed recovery root needs rebuilding, and
// admitting a successor.
export const beginTurnUsage = (
	pi: Harness,
	operation: string,
	finalizedPrevious?: string,
	hasSeed = false,
): Promise<BeginTurnUsageResult> =>
	pi.commit(async (tx) => {
		const active = await tx.doc(ActiveUsage)
		if (active.operation === operation) return { status: "ready" as const }
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
		active.operation = null
		const seedState = await tx.doc(SeedState)
		if (seedState.rebuildRequired && seedState.seededByOperation !== operation) {
			return hasSeed ? { status: "rebuild" as const } : { status: "history_required" as const }
		}
		active.operation = operation
		active.input_tokens = total.input_tokens
		active.output_tokens = total.output_tokens
		return { status: "ready" as const }
	}, BACKGROUND_CONTEXT)

export const settleTurnUsage = async (pi: Harness, operation: string): Promise<ModelUsage> => {
	const closed = await pi.commit(async (tx) => {
		const active = await tx.doc(ActiveUsage)
		if (active.operation !== operation) return undefined
		const usage = await closeUsage(tx, operation, active, await totalUsage(tx))
		active.operation = null
		return usage
	}, BACKGROUND_CONTEXT)
	if (closed !== undefined) return closed
	// Another waiter or the next admission already sealed this operation.
	const saved = await pi.snapshot(SettledUsage, operation, BACKGROUND_CONTEXT)
	if (saved === undefined) throw new Error("Missing Pi operation usage receipt")
	return saved
}
