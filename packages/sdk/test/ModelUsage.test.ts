import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { ModelUsage, addModelUsage, totalModelTokens } from "../src/Schemas.ts"

describe("ModelUsage", () => {
	it("decodes minimal and cache-enriched usage payloads", () => {
		const decode = Schema.decodeUnknownSync(ModelUsage)
		expect(decode({ input_tokens: 10, output_tokens: 5 })).toEqual({
			input_tokens: 10,
			output_tokens: 5,
		})
		expect(
			decode({
				input_tokens: 100,
				output_tokens: 40,
				cache_read_input_tokens: 250,
				cache_creation_input_tokens: 80,
				cache_creation: {
					ephemeral_5m_input_tokens: 50,
					ephemeral_1h_input_tokens: 30,
				},
			}),
		).toEqual({
			input_tokens: 100,
			output_tokens: 40,
			cache_read_input_tokens: 250,
			cache_creation_input_tokens: 80,
			cache_creation: {
				ephemeral_5m_input_tokens: 50,
				ephemeral_1h_input_tokens: 30,
			},
		})
	})

	it("accumulates disjoint cache categories and computes total tokens", () => {
		const first = {
			input_tokens: 100,
			output_tokens: 40,
			cache_read_input_tokens: 250,
			cache_creation_input_tokens: 80,
			cache_creation: {
				ephemeral_5m_input_tokens: 50,
				ephemeral_1h_input_tokens: 30,
			},
		}
		const second = {
			input_tokens: 15,
			output_tokens: 25,
			cache_read_input_tokens: 500,
			cache_creation_input_tokens: 20,
		}
		const combined = addModelUsage(first, second)
		expect(combined).toEqual({
			input_tokens: 115,
			output_tokens: 65,
			cache_read_input_tokens: 750,
			cache_creation_input_tokens: 100,
			cache_creation: {
				ephemeral_5m_input_tokens: 70,
				ephemeral_1h_input_tokens: 30,
			},
		})
		expect(totalModelTokens(combined)).toBe(1030)
		expect(
			addModelUsage({ input_tokens: 1, output_tokens: 2 }, { input_tokens: 3, output_tokens: 4 }),
		).toEqual({
			input_tokens: 4,
			output_tokens: 6,
		})
	})
})
