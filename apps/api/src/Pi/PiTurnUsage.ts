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

interface UsageCounters {
	readonly input_tokens: number
	readonly output_tokens: number
	readonly cache_read_input_tokens: number
	readonly cache_creation_input_tokens: number
	readonly cache_creation_5m_input_tokens: number
	readonly cache_creation_1h_input_tokens: number
}

const buildModelUsage = (counts: UsageCounters): ModelUsage => ({
	input_tokens: counts.input_tokens,
	output_tokens: counts.output_tokens,
	...(counts.cache_read_input_tokens > 0
		? { cache_read_input_tokens: counts.cache_read_input_tokens }
		: {}),
	...(counts.cache_creation_input_tokens > 0
		? {
				cache_creation_input_tokens: counts.cache_creation_input_tokens,
				cache_creation: {
					ephemeral_5m_input_tokens: counts.cache_creation_5m_input_tokens,
					ephemeral_1h_input_tokens: counts.cache_creation_1h_input_tokens,
				},
			}
		: {}),
})

const copyModelUsage = (usage: ModelUsage): ModelUsage => ({
	input_tokens: usage.input_tokens,
	output_tokens: usage.output_tokens,
	...(usage.cache_read_input_tokens === undefined
		? {}
		: { cache_read_input_tokens: usage.cache_read_input_tokens }),
	...(usage.cache_creation_input_tokens === undefined
		? {}
		: { cache_creation_input_tokens: usage.cache_creation_input_tokens }),
	...(usage.cache_creation === undefined
		? {}
		: {
				cache_creation: {
					ephemeral_5m_input_tokens: usage.cache_creation.ephemeral_5m_input_tokens,
					ephemeral_1h_input_tokens: usage.cache_creation.ephemeral_1h_input_tokens,
				},
			}),
})

const totalUsage = async (tx: Tx): Promise<UsageCounters> => {
	const ledger = await tx.doc(UsageDoc, ROOT_CONVERSATION_ID)
	let input_tokens = 0
	let output_tokens = 0
	let cache_read_input_tokens = 0
	let cache_creation_input_tokens = 0
	let cache_creation_5m_input_tokens = 0
	let cache_creation_1h_input_tokens = 0
	for (const usage of Object.values(ledger.models)) {
		input_tokens += usage.input
		output_tokens += usage.output
		cache_read_input_tokens += usage.cacheRead
		cache_creation_input_tokens += usage.cacheWrite
		const write1h = Math.max(0, Math.min(usage.cacheWrite, usage.cacheWrite1h ?? 0))
		cache_creation_1h_input_tokens += write1h
		cache_creation_5m_input_tokens += usage.cacheWrite - write1h
	}
	return {
		input_tokens,
		output_tokens,
		cache_read_input_tokens,
		cache_creation_input_tokens,
		cache_creation_5m_input_tokens,
		cache_creation_1h_input_tokens,
	}
}

const closeUsage = async (
	tx: Tx,
	operation: string,
	start: UsageCounters,
	end: UsageCounters,
): Promise<ModelUsage> => {
	const delta = buildModelUsage({
		input_tokens: Math.max(0, end.input_tokens - start.input_tokens),
		output_tokens: Math.max(0, end.output_tokens - start.output_tokens),
		cache_read_input_tokens: Math.max(
			0,
			end.cache_read_input_tokens - start.cache_read_input_tokens,
		),
		cache_creation_input_tokens: Math.max(
			0,
			end.cache_creation_input_tokens - start.cache_creation_input_tokens,
		),
		cache_creation_5m_input_tokens: Math.max(
			0,
			end.cache_creation_5m_input_tokens - start.cache_creation_5m_input_tokens,
		),
		cache_creation_1h_input_tokens: Math.max(
			0,
			end.cache_creation_1h_input_tokens - start.cache_creation_1h_input_tokens,
		),
	})
	const usage = await tx.doc(SettledUsage, operation, delta)
	return copyModelUsage(usage)
}

const setActiveCounters = (
	active: {
		input_tokens: number
		output_tokens: number
		cache_read_input_tokens: number
		cache_creation_input_tokens: number
		cache_creation_5m_input_tokens: number
		cache_creation_1h_input_tokens: number
	},
	total: UsageCounters,
) => {
	active.input_tokens = total.input_tokens
	active.output_tokens = total.output_tokens
	active.cache_read_input_tokens = total.cache_read_input_tokens
	active.cache_creation_input_tokens = total.cache_creation_input_tokens
	active.cache_creation_5m_input_tokens = total.cache_creation_5m_input_tokens
	active.cache_creation_1h_input_tokens = total.cache_creation_1h_input_tokens
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
		setActiveCounters(active, total)
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
	return copyModelUsage(saved)
}

export const pauseTurnUsage = async (
	pi: Harness,
	operation: string,
	pause: string,
): Promise<ModelUsage> => {
	const key = `${operation}:pause:${pause}`
	const saved = await pi.snapshot(SettledUsage, key, BACKGROUND_CONTEXT)
	if (saved !== undefined) {
		return copyModelUsage(saved)
	}
	const recorded = await pi.commit(async (tx) => {
		const active = await tx.doc(ActiveUsage)
		if (active.operation !== operation) {
			return undefined
		}
		const total = await totalUsage(tx)
		const usage = await closeUsage(tx, key, active, total)
		setActiveCounters(active, total)
		return usage
	}, BACKGROUND_CONTEXT)
	return recorded ?? { input_tokens: 0, output_tokens: 0 }
}
