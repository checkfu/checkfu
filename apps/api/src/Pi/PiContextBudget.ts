export const PI_DEFAULT_COMPACTION_MIN_CONTEXT_WINDOW = 65_536

export const PI_HARNESS_SETTINGS = {
	compaction: {
		backgroundTokens: 0,
	},
	retry: { maxRetries: 3, baseDelayMs: 2000 },
} as const
