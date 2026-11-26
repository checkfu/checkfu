import { describe, expect, it } from "vitest"
import {
	BUILTIN_PROVIDERS,
	DEFAULT_PROVIDER_MODELS,
	resolveModelSpecifier,
} from "../src/Catalog.ts"

describe("DEFAULT_PROVIDER_MODELS", () => {
	it("lists the normalized default model for every builtin provider", () => {
		expect(DEFAULT_PROVIDER_MODELS.map((entry) => entry.provider)).toEqual(
			BUILTIN_PROVIDERS.map((provider) => provider.id),
		)

		for (const entry of DEFAULT_PROVIDER_MODELS) {
			expect(entry.modelId.length).toBeGreaterThan(0)
			expect(entry.modelId.startsWith(`${entry.provider}/`)).toBe(false)
			const resolved = resolveModelSpecifier(entry.specifier)
			expect(resolved).not.toBeNull()
			expect(resolved?.provider).toBe(entry.provider)
			expect(resolved?.modelId).toBe(entry.modelId)
		}
	})
})
