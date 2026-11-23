import type { Models } from "@earendil-works/pi-ai/models"

export const PI_SEED_MAX_CHARS = 100_000
export const PI_SEED_MAX_MESSAGES = 200
export const PI_SEED_MAX_SCAN_PAGES = 20

const DEFAULT_COMPACTION_RESERVE_TOKENS = 16_384
const DEFAULT_COMPACTION_KEEP_RECENT_TOKENS = 20_000
export const SEED_MESSAGE_OVERHEAD_TOKENS = 8

/**
 * Provable conservative token bound for byte-level BPE tokenizers (OpenAI and
 * Anthropic): every token encodes at least one UTF-8 byte, so UTF-8 byte length
 * never underestimates real token count even for random mixed-case ASCII
 * identifiers, punctuation, Japanese/CJK, or emoji.
 */
export const estimateSeedTokens = (text: string): number => {
	let bytes = 0
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i)
		if (code <= 0x7f) {
			bytes += 1
		} else if (code <= 0x7_ff) {
			bytes += 2
		} else if (code >= 0xd8_00 && code <= 0xdb_ff && i + 1 < text.length) {
			const next = text.charCodeAt(i + 1)
			if (next >= 0xdc_00 && next <= 0xdf_ff) {
				bytes += 4
				i += 1
			} else {
				bytes += 3
			}
		} else {
			bytes += 3
		}
	}
	return bytes
}

/**
 * Returns the longest suffix of `text` fitting within both `maxChars` UTF-16
 * code units and `maxTokens` UTF-8 bytes without splitting a surrogate pair.
 */
export const trimTailToBudget = (text: string, maxChars: number, maxTokens: number): string => {
	if (text.length === 0 || maxChars <= 0 || maxTokens <= 0) {
		return ""
	}
	let bytesUsed = 0
	let charsUsed = 0
	let start = text.length
	for (let i = text.length - 1; i >= 0; i--) {
		const code = text.charCodeAt(i)
		let stepChars = 1
		let stepBytes = 3
		if (code >= 0xdc_00 && code <= 0xdf_ff && i > 0) {
			const prev = text.charCodeAt(i - 1)
			if (prev >= 0xd8_00 && prev <= 0xdb_ff) {
				stepChars = 2
				stepBytes = 4
			}
		} else if (code <= 0x7f) {
			stepBytes = 1
		} else if (code <= 0x7_ff) {
			stepBytes = 2
		}
		if (charsUsed + stepChars > maxChars || bytesUsed + stepBytes > maxTokens) {
			break
		}
		charsUsed += stepChars
		bytesUsed += stepBytes
		start = i - (stepChars - 1)
		if (stepChars === 2) {
			i -= 1
		}
	}
	return text.slice(start)
}

export interface CodePointCost {
	readonly chars: number
	readonly bytes: number
}

/**
 * Returns the UTF-16 code-unit length and UTF-8 byte length of the final
 * complete code point in a non-empty string.
 */
export const trailingCodePointCost = (text: string): CodePointCost => {
	if (text.length === 0) {
		return { chars: 0, bytes: 0 }
	}
	const last = text.charCodeAt(text.length - 1)
	if (last >= 0xdc_00 && last <= 0xdf_ff && text.length >= 2) {
		const prev = text.charCodeAt(text.length - 2)
		if (prev >= 0xd8_00 && prev <= 0xdb_ff) {
			return { chars: 2, bytes: 4 }
		}
	}
	if (last <= 0x7f) {
		return { chars: 1, bytes: 1 }
	}
	if (last <= 0x7_ff) {
		return { chars: 1, bytes: 2 }
	}
	return { chars: 1, bytes: 3 }
}

export const compactionReserveTokens = (contextWindow: number): number =>
	Math.min(DEFAULT_COMPACTION_RESERVE_TOKENS, Math.max(1, Math.floor(contextWindow * 0.25)))

/**
 * Computes the maximum token budget available for rebuilt conversation history
 * given the resolved model's context window, reserving room for output/compaction
 * headroom, system instructions, and the current turn's user input.
 */
export const seedTokenBudget = ({
	contextWindow,
	system,
	currentInput,
}: {
	readonly contextWindow: number
	readonly system: string | null
	readonly currentInput: string
}): number => {
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
		return 0
	}
	const reserveTokens = compactionReserveTokens(contextWindow)
	const systemTokens =
		system !== null && system.length > 0
			? estimateSeedTokens(system) + SEED_MESSAGE_OVERHEAD_TOKENS
			: 0
	const inputTokens = estimateSeedTokens(currentInput) + SEED_MESSAGE_OVERHEAD_TOKENS
	return Math.max(0, contextWindow - reserveTokens - systemTokens - inputTokens)
}

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
