// Pi reserves 16,384 tokens for a compaction and keeps the newest 20,000, so its defaults need
// a window of at least 65,536. PiCatalog offers no model with a smaller one.
export const PI_DEFAULT_COMPACTION_MIN_CONTEXT_WINDOW = 65_536

export const PI_HARNESS_SETTINGS = {
	compaction: {
		// Blocking compactions finish inside their turn. Background jobs can outlive it.
		backgroundTokens: 0,
	},
	retry: { maxRetries: 3, baseDelayMs: 2000 },
} as const
