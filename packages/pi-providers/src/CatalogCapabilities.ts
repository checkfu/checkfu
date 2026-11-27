/**
 * Deduplicated runtime capability and pricing palettes (`cost`, `thinkingLevelMap`,
 * wire `compat`, and `inputLimits`) referenced by index from `CatalogIndex.ts`.
 *
 * Kept separate from `CatalogIndex.ts` so public API Workers never bundle runtime
 * codec capability or pricing tables while `PiHarnessWorker` reconstructs lossless models.
 *
 * Regenerate via: `bun packages/pi-providers/scripts/sync-catalog-index.ts`
 * Parity is enforced by `test/Providers.test.ts`.
 */

import type {
	AnthropicMessagesCompat,
	Model,
	OpenAICompletionsCompat,
	OpenAIResponsesCompat,
} from "@earendil-works/pi-ai"
import type { CatalogIndexEntry } from "./CatalogIndex.ts"
import type { WireFormat } from "./Types.ts"

export type IndexedThinkingLevelMap = NonNullable<Model<WireFormat>["thinkingLevelMap"]>
export type IndexedInputLimits = NonNullable<Model<WireFormat>["inputLimits"]>

type CostTierTuple = readonly [
	inputTokensAbove: number,
	input: number,
	output: number,
	cacheRead: number,
	cacheWrite: number,
]

type CostTuple = readonly [
	input: number,
	output: number,
	cacheRead: number,
	cacheWrite: number,
	tiers?: ReadonlyArray<CostTierTuple>,
]

export const ZERO_COST: Model<WireFormat>["cost"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
}

const MODEL_COSTS: ReadonlyArray<CostTuple> = [
	[0.8, 1.6, 0.2, 0],
	[3, 6, 0.75, 0],
	[0.7, 1.4, 0.18, 0],
	[0.3, 2.5, 0, 0],
	[0.06, 0.24, 0, 0],
	[0.035, 0.14, 0, 0],
	[2.5, 12.5, 0.625, 0],
	[0.8, 3.2, 0, 0],
	[10, 50, 1, 12.5],
	[10, 50, 0.25, 12.5],
	[5, 25, 0.125, 6.25],
	[8, 40, 0.2, 10],
	[4, 20, 0.1, 5],
	[5, 25, 0.5, 6.25],
	[1, 5, 0.1, 1.25],
	[0.5, 2.5, 0.05, 0.625],
	[0.1, 0.5, 0.01, 0.125, [[100_000, 0.5, 2.5, 0.05, 0.625]]],
	[0.05, 0.25, 0.005, 0.0625, [[100_000, 0.25, 1.25, 0.025, 0.3125]]],
	[15, 75, 1.5, 18.75],
	[7.5, 37.5, 0.75, 9.375],
	[2.5, 12.5, 0.25, 3.125],
	[4, 20, 0.2, 5],
	[2, 10, 0.1, 2.5],
	[3, 15, 0.3, 3.75, [[200_000, 6, 22.5, 0.6, 7.5]]],
	[1.5, 7.5, 0.15, 1.875, [[200_000, 3, 11.25, 0.3, 3.75]]],
	[3, 15, 0.3, 3.75],
	[1.5, 7.5, 0.15, 1.875],
	[2, 10, 0.2, 2.5],
	[1, 5, 0.05, 1.25],
	[0, 0, 0, 0],
	[1.13, 3.94, 0.113, 0],
	[0.5, 2.5, 0, 0],
	[0.25, 2, 0, 0, [[128_000, 0.5, 4, 0, 0]]],
	[0.1, 0.4, 0, 0, [[128_000, 0.2, 0.8, 0, 0]]],
	[2.5, 10, 0, 0],
	[0.3, 1.5, 0.15, 0],
	[0.15, 0.6, 0, 0],
	[0.0375, 0.15, 0, 0],
	[0.2574, 1.0287, 0, 0],
	[0.25, 1, 0, 0],
	[0.25, 0.95, 0.13, 0],
	[0.571, 2.286, 0, 0],
	[0.27, 1, 0, 0],
	[0.26, 0.38, 0.13, 0],
	[0.27, 0.41, 0, 0],
	[0.09, 0.18, 0.018, 0],
	[0.0456, 0.3, 0.035, 0],
	[0.048, 0.144, 0.012, 0],
	[0.2156, 0.6468, 0.00686, 0],
	[0.75557, 1.5007, 0.21, 0],
	[0.0999, 5, 0.0999, 0],
	[0.0507, 0.2028, 0.001014, 0],
	[0.15, 0.6, 0.003, 0],
	[0.035, 0.149, 0.0029, 0],
	[0.05, 0.15, 0.004, 0],
	[0.6, 3, 0.06, 0],
	[3, 15, 0.3, 0],
	[0.3, 2.5, 0.03, 0.083333],
	[0.1, 0.4, 0.01, 0.083333],
	[1.25, 10, 0.125, 0.375, [[200_000, 2.5, 15, 0.25, 0.375]]],
	[0.5, 3, 0.05, 0.083333],
	[0.25, 1.5, 0, 0],
	[2, 12, 0.2, 0.375],
	[0.25, 1.5, 0.025, 0.083333],
	[0.125, 0.75, 0.0125, 0],
	[2, 12, 0.2, 0.375, [[200_000, 4, 18, 0.4, 0.375]]],
	[1, 6, 0, 0, [[200_000, 2, 9, 0, 0]]],
	[1.5, 9, 0.15, 0.083333],
	[0.15, 1.25, 0.015, 0],
	[0.75, 4.5, 0.075, 0],
	[0.75, 3.75, 0.075, 0.041667],
	[0.375, 1.875, 0.0375, 0.041667],
	[0.825, 4.125, 0.0825, 0.041667],
	[2, 10, 0.1, 0.1875],
	[1, 5, 0.05, 0.1875],
	[1.5, 7.5, 0.075, 0.083333],
	[0.75, 3.75, 0.0375, 0.083333],
	[3, 15, 0.15, 0.083333],
	[1.5, 7.5, 0, 0],
	[0.05, 0.15, 0, 0],
	[0.08, 0.16, 0, 0],
	[0.09, 0.3, 0.05, 0],
	[0.2, 0.4, 0, 0],
	[0.06, 0.15, 0.015, 0],
	[0.021, 0.063, 0.0042, 0],
	[0.06, 0.18, 0.012, 0],
	[0.015, 0.045, 0.003, 0],
	[0.075, 0.225, 0.015, 0],
	[0.3, 0.9, 0.06, 0],
	[0.2, 0.8, 0.04, 0],
	[0.05, 0.7, 0.025, 0],
	[0.08, 0.2, 0.02, 0],
	[0.72, 0.72, 0, 0],
	[0.05, 0.08, 0.025, 0],
	[0.59, 0.79, 0.295, 0],
	[0.35, 1, 0.17, 0],
	[0.1, 0.3, 0, 0],
	[0.1, 0.5, 0.004, 0.125],
	[0.3, 1.2, 0.04, 0],
	[0.24, 0.96, 0.032, 0],
	[1.25, 4.25, 0.15, 0],
	[0.1, 0.2, 0.002, 0],
	[4, 20, 0.2, 0],
	[0.3, 1.2, 0.06, 0],
	[0.6, 1.8, 0, 0],
	[0.075, 0.3, 0.0075, 0],
	[0.224, 0.88, 0.0448, 0],
	[0.3, 0.9, 0.03, 0],
	[0.15, 0.45, 0.015, 0],
	[0.4, 2, 0.04, 0],
	[0.2, 0.2, 0.02, 0],
	[0.1, 0.1, 0.01, 0],
	[0.15, 0.15, 0.015, 0],
	[0.075, 0.075, 0.0075, 0],
	[2, 6, 0.2, 0],
	[0.5, 1.5, 0.05, 0],
	[0.25, 0.75, 0.025, 0],
	[0.7, 2.1, 0.07, 0],
	[0.75, 3.75, 0, 0],
	[0.029, 0.03, 0, 0],
	[0.2, 0.6, 0.02, 0],
	[0.15, 0.6, 0.015, 0],
	[0.351, 0.555, 0, 0],
	[0.075, 0.2, 0, 0],
	[0.1, 0.3, 0.01, 0],
	[0.57, 2.3, 0, 0],
	[0.6, 2.5, 0, 0],
	[0.41, 2.06, 0.07, 0],
	[0.65, 3.41, 0.15, 0],
	[0.6, 3, 0.12, 0],
	[0.192, 16, 0.182, 0],
	[0.2403, 8.4023, 0.2, 0],
	[0.372, 5.583, 0.1, 0],
	[2.28, 11.4, 0.228, 0],
	[0.075, 0.25, 0.015, 0],
	[0.12, 0.4, 0.024, 0],
	[0.06, 0.24, 0.012, 0],
	[0.075, 0.4, 0, 0],
	[0.5, 2.2, 0.1, 0],
	[0.07, 0.2, 0.04, 0],
	[0.15, 0.47, 0.02, 0],
	[1, 2, 0, 0],
	[3, 4, 0, 0],
	[30, 60, 0, 0],
	[5, 15, 0, 0],
	[2, 8, 0.5, 0],
	[0.4, 1.6, 0.1, 0],
	[0.2, 0.8, 0.05, 0],
	[0.1, 0.4, 0.03, 0],
	[0.05, 0.2, 0.0125, 0],
	[1, 4, 0.25, 0],
	[2.5, 10, 1.25, 0],
	[0.15, 0.6, 0.075, 0],
	[0.075, 0.3, 0.0375, 0],
	[1.25, 5, 0.625, 0],
	[1.25, 10, 0.125, 0],
	[0.25, 2, 0.025, 0],
	[0.125, 1, 0.0125, 0],
	[0.05, 0.4, 0.005, 0],
	[0.025, 0.2, 0.0025, 0],
	[15, 120, 0, 0],
	[7.5, 60, 0, 0],
	[1.25, 10, 0.13, 0],
	[0.25, 2, 0.03, 0],
	[0.625, 5, 0.0625, 0],
	[1.75, 14, 0.175, 0],
	[21, 168, 0, 0],
	[10.5, 84, 0, 0],
	[0.875, 7, 0.0875, 0],
	[2.5, 15, 0.25, 0, [[272_000, 5, 22.5, 0.5, 0]]],
	[0.375, 2.25, 0.0375, 0],
	[0.2, 1.25, 0.02, 0],
	[0.1, 0.625, 0.01, 0],
	[30, 180, 0, 0, [[272_000, 60, 270, 0, 0]]],
	[15, 90, 0, 0, [[272_000, 30, 135, 0, 0]]],
	[1.25, 7.5, 0.125, 0, [[272_000, 2.5, 11.25, 0.25, 0]]],
	[5, 30, 0.5, 0, [[272_000, 10, 45, 1, 0]]],
	[0.2, 1.2, 0.02, 0.25, [[272_000, 0.4, 1.8, 0.04, 0.5]]],
	[0.1, 0.6, 0.01, 0, [[272_000, 0.2, 0.9, 0.02, 0]]],
	[4, 20, 0.4, 5, [[272_000, 8, 30, 0.8, 10]]],
	[2, 10, 0.2, 2.5, [[272_000, 4, 15, 0.4, 5]]],
	[2, 12, 0.2, 2.5, [[272_000, 4, 18, 0.4, 5]]],
	[1, 6, 0.1, 0, [[272_000, 2, 9, 0.2, 0]]],
	[10, 50, 1, 12.5, [[272_000, 20, 75, 2, 25]]],
	[5, 25, 0.5, 6.25, [[272_000, 10, 37.5, 1, 12.5]]],
	[0.1, 0.5, 0.01, 0.125, [[272_000, 0.2, 0.75, 0.02, 0.25]]],
	[0.05, 0.25, 0.005, 0.0625, [[272_000, 0.1, 0.375, 0.01, 0.125]]],
	[1, 5, 0.1, 1.25, [[272_000, 2, 7.5, 0.2, 2.5]]],
	[2, 10, 0.1, 2.5, [[272_000, 4, 15, 0.2, 5]]],
	[1, 5, 0.05, 1.25, [[272_000, 2, 7.5, 0.1, 2.5]]],
	[0.5, 2.5, 0.025, 0.625, [[272_000, 1, 3.75, 0.05, 1.25]]],
	[8, 40, 0.4, 10, [[272_000, 16, 60, 0.8, 20]]],
	[4, 20, 0.2, 5, [[272_000, 8, 30, 0.4, 10]]],
	[0.6, 2.4, 0, 0],
	[5, 30, 0.5, 0],
	[0.05, 0.25, 0.05, 0],
	[0.0296, 0.136, 0, 0],
	[0.03, 0.13, 0.03, 0],
	[0.024, 0.112, 0, 0],
	[0.55, 2.2, 0.275, 0],
	[20, 80, 0, 0],
	[0.55, 2.2, 0.1375, 0],
	[0.07, 0.5, 0.03, 0],
	[0.15, 1.5, 0, 0],
	[0.075, 0.5, 0.0375, 0],
	[0.08, 0.13, 0.04, 0],
	[0.36, 0.4, 0, 0],
	[0.26, 0.78, 0.052, 0.325, [[256_000, 0.78, 2.34, 0.156, 0.975]]],
	[0.12, 0.24, 0, 0],
	[0.14, 0.8, 0.05, 0],
	[0.45, 3.5, 0, 0],
	[0.12, 0.5, 0, 0],
	[0.1, 0.3, 0.1, 0],
	[0.08, 0.28, 0, 0],
	[0.3, 1, 0.1, 0],
	[0.07, 0.28, 0, 0],
	[
		0.195,
		0.975,
		0.039,
		0.24375,
		[
			[32_000, 0.325, 1.625, 0.065, 0.40625],
			[128_000, 0.52, 2.6, 0.104, 0.65],
		],
	],
	[0.12, 0.8, 0.07, 0],
	[0.1, 1.1, 0.07, 0],
	[0.21, 1.9, 0.1, 0],
	[0.25, 0.75, 0.12, 0],
	[0.26, 2.08, 0, 0],
	[0.26, 2.6, 0, 0],
	[0.14, 1, 0.05, 0],
	[0.5, 3.6, 0.3, 0],
	[0.1, 0.25, 0, 0],
	[0.065, 0.26, 0, 0],
	[0.26, 1.56, 0, 0, [[256_000, 0.325, 1.95, 0, 0]]],
	[0.3, 1.8, 0, 0.375, [[256_000, 0.375, 2.25, 0, 0.46875]]],
	[0.32, 3.2, 0, 0],
	[0.1, 0.89, 0.035, 0],
	[0.1875, 1.125, 0, 0.234375, [[256_000, 0.75, 3, 0, 0.9375]]],
	[0.325, 1.95, 0, 0.40625, [[256_000, 1.3, 3.9, 0, 1.625]]],
	[
		0.03,
		0.13,
		0.006,
		0.038,
		[
			[32_000, 0.1, 0.4, 0.02, 0.125],
			[256_000, 0.2, 0.8, 0.04, 0.25],
		],
	],
	[1.475, 4.425, 0.295, 1.84375],
	[0.32, 1.28, 0.064, 0.4, [[256_000, 0.96, 3.84, 0.192, 1.2]]],
	[0.23, 0.92, 0, 0],
	[2, 6, 0.25, 0],
	[0.06, 1.96, 0.059, 0],
	[0.16, 2, 0.04, 0],
	[0.15, 0.47, 0.016, 0],
	[1.15, 3.45, 0, 0],
	[4, 12, 0.5, 0],
	[1.425, 4.275, 0.07125, 1.78125],
	[0.15, 1.875, 0.0375, 0],
	[0.3, 1, 0.04, 0],
	[0.1, 0.1, 0, 0],
	[1, 3, 0, 0],
	[0.1, 0.3, 0.025, 0],
	[0.95, 4, 0.15, 0],
	[0.2, 1.15, 0.04, 0],
	[1, 2.7, 0.1, 0],
	[0.0825, 0.33, 0.020625, 0],
	[0.417, 1.2505, 0.021, 0],
	[0.035, 0.1405, 0.0015, 0],
	[0.7506, 2.2509, 0.0378, 0],
	[1, 4.05, 0.17, 0],
	[0.3, 1, 0.03, 0],
	[0.45, 1.2, 0.1, 0],
	[0.36, 0.96, 0.08, 0],
	[0.01, 0.04, 0.001, 0],
	[0.05, 0.2, 0.005, 0],
	[0.09, 0.36, 0.018, 0],
	[0.15, 0.6, 0.03, 0],
	[1.25, 2.5, 0.2, 0, [[200_000, 2.5, 5, 0.4, 0]]],
	[1, 2, 0.16, 0, [[200_000, 2, 4, 0.32, 0]]],
	[2, 6, 0.3, 0, [[200_000, 4, 12, 0.6, 0]]],
	[2, 6, 0.5, 0, [[200_000, 4, 12, 1, 0]]],
	[1.6, 4.8, 0.4, 0, [[200_000, 3.2, 9.6, 0.8, 0]]],
	[0.14, 0.28, 0.0028, 0],
	[0.5, 1, 0.05, 0],
	[0.435, 0.87, 0.0036, 0],
	[4.35, 8.7, 0.036, 0],
	[0.6, 2.2, 0.11, 0],
	[0.2, 1.1, 0.03, 0],
	[0.6, 1.8, 0.11, 0],
	[0.5, 2, 0.1, 0],
	[0.3, 0.9, 0.05, 0],
	[0.0605, 0.4, 0, 0],
	[0.6, 1.9, 0.119, 0],
	[1.2, 4, 0.24, 0],
	[1.4, 4.4, 0.26, 0],
	[0.62, 2.42, 0.14, 0],
	[0.322, 0.989, 0.109, 0],
	[0.0699, 1.4, 0.0689, 0],
	[0.15, 0.5, 0.03, 0],
	[0.023, 0.068, 0.009, 0],
	[0.37, 1.25, 0.075, 0],
	[1.68, 5.28, 0.336, 0],
	[0.28, 1.249, 0.061, 0],
	[0.036, 0.5, 0.01, 0],
	[0.04532, 0.13596, 0.001442, 0],
	[0.1824, 11.0055, 0.18, 0],
	[0.0356, 0.0815, 0.03, 0],
	[2.5, 15, 0.25, 0],
	[30, 180, 0, 0],
	[5, 30, 0, 0],
	[1.1, 4.4, 0.55, 0],
	[1.1, 4.4, 0.275, 0],
	[0.3, 1.2, 0.006, 0],
	[0.1, 0.3, 0.05, 0],
	[0.017, 0.112, 0, 0],
	[0.293, 2.253, 0, 0],
	[0.27, 0.85, 0, 0],
	[0.35, 0.75, 0, 0],
	[0.2, 0.3, 0, 0],
	[0.45, 3.2, 0.05, 0],
]

const THINKING_LEVEL_MAPS: ReadonlyArray<IndexedThinkingLevelMap> = [
	{ off: null },
	{ off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
	{
		off: null,
		minimal: null,
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "xhigh",
		max: "max",
	},
	{
		off: "none",
		minimal: null,
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "xhigh",
		max: "max",
	},
	{
		off: "none",
		minimal: null,
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: null,
		max: "max",
	},
	{
		off: "none",
		minimal: null,
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: null,
		max: null,
	},
	{ off: "none", minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
	{
		off: "none",
		minimal: "minimal",
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: null,
		max: null,
	},
	{ off: "none", minimal: null, low: null, medium: null, high: "high", xhigh: "xhigh", max: null },
	{ off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null },
	{
		off: null,
		minimal: "minimal",
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: null,
		max: null,
	},
	{
		off: null,
		minimal: null,
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "xhigh",
		max: null,
	},
	{
		off: "none",
		minimal: "minimal",
		low: null,
		medium: null,
		high: "high",
		xhigh: null,
		max: null,
	},
	{ off: "none", minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: null },
	{
		off: null,
		minimal: "minimal",
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "xhigh",
		max: "max",
	},
	{
		off: null,
		minimal: "minimal",
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "xhigh",
		max: null,
	},
	{ off: "none", minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null },
	{ off: "none", minimal: null, low: null, medium: "medium", high: "high", xhigh: null, max: null },
	{ off: null, minimal: null, low: null, medium: "medium", high: "high", xhigh: null, max: null },
	{ off: "none", minimal: null, low: "low", medium: "medium", high: null, xhigh: null, max: null },
	{ off: null, minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null },
	{
		off: "none",
		minimal: null,
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "xhigh",
		max: null,
	},
	{ xhigh: "xhigh" },
	{
		off: null,
		minimal: null,
		low: null,
		medium: "medium",
		high: "high",
		xhigh: "xhigh",
		max: null,
	},
	{
		off: "none",
		minimal: "minimal",
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "xhigh",
		max: "max",
	},
	{
		off: "none",
		minimal: null,
		low: null,
		medium: "medium",
		high: null,
		xhigh: "xhigh",
		max: null,
	},
	{ off: null, minimal: null, low: "low", medium: "medium", high: null, xhigh: "xhigh", max: null },
	{
		off: "none",
		minimal: null,
		low: "low",
		medium: "medium",
		high: null,
		xhigh: "xhigh",
		max: null,
	},
	{ off: "none", minimal: null, low: "low", medium: null, high: "high", xhigh: "xhigh", max: null },
	{ off: null, minimal: null, low: null, medium: null, high: "high", xhigh: "xhigh", max: "max" },
	{
		off: "none",
		minimal: "minimal",
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: null,
		max: "max",
	},
	{
		off: null,
		minimal: "minimal",
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: null,
		max: "max",
	},
	{ xhigh: "xhigh", max: "max", off: null },
	{ xhigh: "xhigh", max: "max" },
	{ max: "max" },
	{ minimal: null, low: null, medium: null, high: "high", max: "max" },
]

const ANTHROPIC_COMPATS: ReadonlyArray<AnthropicMessagesCompat> = [
	{ forceAdaptiveThinking: true },
	{ forceAdaptiveThinking: true, supportsMidConvoEffort: true },
	{ forceAdaptiveThinking: true, supportsTemperature: false, supportsMidConvoEffort: true },
	{ forceAdaptiveThinking: true, supportsTemperature: false },
	{ sendSessionAffinityHeaders: true, forceAdaptiveThinking: true },
	{ sendSessionAffinityHeaders: true },
	{ sendSessionAffinityHeaders: true, forceAdaptiveThinking: true, supportsTemperature: false },
]

const OPENAI_RESPONSES_COMPATS: ReadonlyArray<OpenAIResponsesCompat> = [
	{ supportsStrictMode: true },
	{ supportsStrictMode: true, supportsOpenAIGrammarTools: true },
]

const OPENAI_COMPLETIONS_COMPATS: ReadonlyArray<OpenAICompletionsCompat> = [
	{ thinkingFormat: "openrouter", supportsStrictMode: true, sendSessionAffinityHeaders: true },
	{
		thinkingFormat: "openrouter",
		supportsStrictMode: true,
		cacheControlFormat: "anthropic",
		sendSessionAffinityHeaders: true,
	},
	{
		thinkingFormat: "openrouter",
		supportsStrictMode: true,
		sendSessionAffinityHeaders: true,
		requiresReasoningContentOnAssistantMessages: true,
	},
	{
		thinkingFormat: "openrouter",
		supportsStrictMode: true,
		sendSessionAffinityHeaders: true,
		supportsMidConvoSystemMessages: true,
	},
	{
		supportsStore: false,
		supportsReasoningEffort: false,
		maxTokensField: "max_tokens",
		supportsLongCacheRetention: false,
		sendSessionAffinityHeaders: true,
	},
	{
		supportsStore: false,
		supportsReasoningEffort: false,
		maxTokensField: "max_tokens",
		supportsLongCacheRetention: false,
		sendSessionAffinityHeaders: true,
		requiresReasoningContentOnAssistantMessages: true,
		thinkingFormat: "deepseek",
	},
	{
		supportsStore: false,
		supportsStrictMode: true,
		supportsLongCacheRetention: false,
		sendSessionAffinityHeaders: true,
	},
	{
		supportsStore: false,
		supportsStrictMode: true,
		supportsLongCacheRetention: false,
		sendSessionAffinityHeaders: true,
		requiresReasoningContentOnAssistantMessages: true,
		thinkingFormat: "deepseek",
	},
	{
		supportsStore: false,
		supportsStrictMode: true,
		supportsLongCacheRetention: false,
		sendSessionAffinityHeaders: true,
		requiresNonNullAssistantContent: true,
	},
]

const MODEL_INPUT_LIMITS: ReadonlyArray<IndexedInputLimits> = [
	{ images: { resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4_718_592, jpegQuality: 80 } } },
]

export const getIndexedCost = (index: number): Model<WireFormat>["cost"] => {
	const tuple = index >= 0 ? MODEL_COSTS[index] : undefined
	if (tuple === undefined) {
		return ZERO_COST
	}
	const [input, output, cacheRead, cacheWrite, tiers] = tuple
	return tiers === undefined
		? { input, output, cacheRead, cacheWrite }
		: {
				input,
				output,
				cacheRead,
				cacheWrite,
				tiers: tiers.map(([inputTokensAbove, tierIn, tierOut, tierRead, tierWrite]) => ({
					inputTokensAbove,
					input: tierIn,
					output: tierOut,
					cacheRead: tierRead,
					cacheWrite: tierWrite,
				})),
			}
}

export const getIndexedThinkingLevelMap = (index: number): IndexedThinkingLevelMap | undefined =>
	index >= 0 ? THINKING_LEVEL_MAPS[index] : undefined

export const getIndexedInputLimits = (index: number): IndexedInputLimits | undefined =>
	index >= 0 ? MODEL_INPUT_LIMITS[index] : undefined

export const getIndexedAnthropicCompat = (index: number): AnthropicMessagesCompat | undefined =>
	index >= 0 ? ANTHROPIC_COMPATS[index] : undefined

export const getIndexedOpenAIResponsesCompat = (index: number): OpenAIResponsesCompat | undefined =>
	index >= 0 ? OPENAI_RESPONSES_COMPATS[index] : undefined

export const getIndexedOpenAICompletionsCompat = (
	index: number,
): OpenAICompletionsCompat | undefined =>
	index >= 0 ? OPENAI_COMPLETIONS_COMPATS[index] : undefined

export interface HydrateIndexedModelOptions {
	readonly provider: string
	readonly id?: string
	readonly baseUrl: string
	readonly formatOverride?: WireFormat
	readonly costOverride?: Model<WireFormat>["cost"]
	readonly anthropicCompatOverride?: AnthropicMessagesCompat
	readonly openAIResponsesCompatOverride?: OpenAIResponsesCompat
	readonly openAICompletionsCompatOverride?: OpenAICompletionsCompat
	readonly headers?: Record<string, string>
}

export const hydrateIndexedModel = (
	entry: CatalogIndexEntry,
	options: HydrateIndexedModelOptions,
): Model<WireFormat> => {
	const format = options.formatOverride ?? entry.api
	const thinkingLevelMap = getIndexedThinkingLevelMap(entry.thinkingLevelMapIndex)
	const inputLimits = getIndexedInputLimits(entry.inputLimitsIndex)
	const id = options.id ?? entry.id
	const base = {
		id,
		name: id,
		provider: options.provider,
		baseUrl: options.baseUrl,
		reasoning: entry.reasoning,
		input: [...entry.input],
		cost: options.costOverride ?? getIndexedCost(entry.costIndex),
		contextWindow: entry.contextWindow,
		maxTokens: entry.maxTokens,
		...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
		...(inputLimits === undefined ? {} : { inputLimits }),
		...(options.headers === undefined ? {} : { headers: options.headers }),
	}
	switch (format) {
		case "anthropic-messages": {
			const compat =
				options.anthropicCompatOverride ??
				(entry.api === "anthropic-messages"
					? getIndexedAnthropicCompat(entry.compatIndex)
					: undefined)
			return {
				...base,
				api: "anthropic-messages",
				...(compat === undefined ? {} : { compat }),
			}
		}
		case "openai-responses": {
			const compat =
				options.openAIResponsesCompatOverride ??
				(entry.api === "openai-responses"
					? getIndexedOpenAIResponsesCompat(entry.compatIndex)
					: undefined)
			return {
				...base,
				api: "openai-responses",
				...(compat === undefined ? {} : { compat }),
			}
		}
		case "openai-completions": {
			const compat =
				options.openAICompletionsCompatOverride ??
				(entry.api === "openai-completions"
					? getIndexedOpenAICompletionsCompat(entry.compatIndex)
					: undefined)
			return {
				...base,
				api: "openai-completions",
				...(compat === undefined ? {} : { compat }),
			}
		}
	}
}
