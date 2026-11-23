import type { Models } from "@earendil-works/pi-ai/models"

const DEFAULT_COMPACTION_RESERVE_TOKENS = 16_384
const DEFAULT_COMPACTION_KEEP_RECENT_TOKENS = 20_000
export const compactionReserveTokens = (contextWindow: number): number =>
	Math.min(DEFAULT_COMPACTION_RESERVE_TOKENS, Math.max(1, Math.floor(contextWindow * 0.25)))

export const PI_HARNESS_SETTINGS = {
	// Blocking compactions finish inside their turn. Background jobs can outlive it.
	compaction: { backgroundTokens: 0 },
	retry: { maxRetries: 3, baseDelayMs: 2000 },
} as const

/**
 * Computes safe compaction thresholds strictly below `contextWindow` so
 * small-context models (e.g. `openai/gpt-4` at 8,192 tokens) can compact
 * instead of retaining more tokens than fit in their window.
 */
export const compactionThresholdsForContextWindow = (
	contextWindow: number,
): { readonly reserveTokens: number; readonly keepRecentTokens: number } | null => {
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
		return null
	}
	const reserveTokens = compactionReserveTokens(contextWindow)
	const available = Math.max(1, contextWindow - reserveTokens)
	const keepRecentTokens = Math.min(
		DEFAULT_COMPACTION_KEEP_RECENT_TOKENS,
		Math.max(1, Math.floor(available * 0.5)),
	)
	if (
		reserveTokens === DEFAULT_COMPACTION_RESERVE_TOKENS &&
		keepRecentTokens === DEFAULT_COMPACTION_KEEP_RECENT_TOKENS
	) {
		return null
	}
	return { reserveTokens, keepRecentTokens }
}

export const createPiHarnessSettings = (models: Models) => {
	const modelOverrides: Record<
		string,
		{
			readonly reserveTokens: number
			readonly keepRecentTokens: number
			readonly backgroundTokens: 0
		}
	> = {}
	for (const model of models.getModels()) {
		const override = compactionThresholdsForContextWindow(model.contextWindow)
		if (override !== null) {
			modelOverrides[`${model.provider}/${model.id}`] = {
				...override,
				backgroundTokens: 0,
			}
		}
	}
	return {
		compaction: {
			backgroundTokens: 0,
			...(Object.keys(modelOverrides).length > 0 ? { modelOverrides } : {}),
		},
		retry: PI_HARNESS_SETTINGS.retry,
	}
}
