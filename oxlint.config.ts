import cloudflare from "@cloudflare/oxlint-config"
import { strict as effectStrict } from "@effect/tsgo/oxlint-presets"
import { defineConfig } from "oxlint"
import type { OxlintConfig } from "oxlint"

// Each operation is confined to the one file that owns it. That file is exempt from its own
// entry and from nothing else.
const OWNED = [
	{
		owner: "apps/api/src/Pi/PiDocRegistry.ts",
		message:
			"Declare Checkfu Pi documents and document families in apps/api/src/Pi/PiDocRegistry.ts so they are covered by Persisted.lock.json.",
		imports: [
			{ name: "@earendil-works/pi-durable", importNames: ["defineDoc", "defineDocFamily"] },
		],
		properties: ["defineDoc", "defineDocFamily"],
	},
	{
		owner: "apps/api/src/PlacedDurableObjects.ts",
		message:
			"Host the model on PlacedDurableObjects from apps/api/src/PlacedDurableObjects.ts so CHECKFU_JURISDICTION and CHECKFU_LOCATION_HINT apply to its Durable Objects.",
		imports: [{ name: "@alchemy.run/domain/Cloudflare", importNames: ["layerDurableObjects"] }],
		properties: ["layerDurableObjects"],
	},
	{
		owner: "apps/api/src/Placement.ts",
		message:
			"Address a Durable Object with placedStub from apps/api/src/Placement.ts so CHECKFU_JURISDICTION and CHECKFU_LOCATION_HINT apply to it.",
		imports: [],
		properties: ["getByName", "idFromName", "idFromString", "newUniqueId"],
	},
	{
		owner: "packages/domain/src/Session/RunTurnActivities.ts",
		message:
			"Declare RunTurn workflow activities through runTurnActivity in packages/domain/src/Session/RunTurnActivities.ts so they are covered by Persisted.lock.json.",
		imports: [{ name: "effect/workflow", importNames: ["Activity"] }],
		properties: [],
	},
]

const confined = (exempt?: string): NonNullable<OxlintConfig["rules"]> => {
	const enforced = OWNED.filter(({ owner }) => owner !== exempt)
	return {
		"no-restricted-imports": [
			"error",
			{
				paths: enforced.flatMap(({ message, imports }) =>
					imports.map((path) => ({ ...path, allowTypeImports: true, message })),
				),
			},
		],
		"no-restricted-properties": [
			"error",
			...enforced.flatMap(({ message, properties }) =>
				properties.map((property) => ({ property, message })),
			),
		],
	}
}

export default defineConfig({
	...cloudflare,
	extends: [effectStrict],
	ignorePatterns: [...(cloudflare.ignorePatterns ?? []), ".turbo", "**/routeTree.gen.ts"],
	rules: {
		...cloudflare.rules,
		"effecttsgo/any-unknown-in-error-context": "error",
		"effecttsgo/crypto-random-uuid-in-effect": "error",
		"effecttsgo/effect-try-without-catch": "error",
		"effecttsgo/experimental-api-usage": "off",
		"effecttsgo/global-console-in-effect": "error",
		"effecttsgo/global-date-in-effect": "error",
		"effecttsgo/global-fetch-in-effect": "error",
		"effecttsgo/global-random-in-effect": "error",
		"effecttsgo/global-timers-in-effect": "error",
		"effecttsgo/map-map-error-to-map-both": "error",
		"effecttsgo/nested-effect-gen-yield": "error",
		"effecttsgo/prefer-schema-type-property": "error",
		"effecttsgo/process-env-in-effect": "error",
		"effecttsgo/promise-all-in-effect": "error",
		"effecttsgo/promise-race-in-effect": "error",
		"effecttsgo/provide-merge-all-to-array": "error",
		"effecttsgo/schema-union-of-literals": "error",
		"effecttsgo/service-not-as-class": "error",
		"effecttsgo/unsafe-effect-type-assertion": "error",
		"effecttsgo/unstable-api-usage": "off",
		"@typescript-eslint/ban-ts-comment": [
			"error",
			{ "ts-expect-error": { descriptionFormat: String.raw`^ -- boundary: \S` } },
		],
		"import/no-cycle": "error",
		"import/no-duplicates": "error",
		"no-proto": "error",
		...confined(),
		"no-sequences": "error",
		"promise/no-new-statics": "error",
		"promise/valid-params": "error",
		"vitest/no-focused-tests": "error",
		"vitest/no-disabled-tests": "error",
		"vitest/no-standalone-expect": [
			"error",
			{
				additionalTestBlockFunctions: [
					"it.effect",
					"it.effect.each",
					"it.effect.fails",
					"it.effect.only",
					"it.effect.prop",
					"it.effect.runIf",
					"it.effect.skip",
					"it.effect.skipIf",
					"it.live",
					"it.live.each",
					"it.live.fails",
					"it.live.only",
					"it.live.prop",
					"it.live.runIf",
					"it.live.skip",
					"it.live.skipIf",
					"it.prop",
					"effect",
					"effect.each",
					"effect.fails",
					"effect.only",
					"effect.prop",
					"effect.runIf",
					"effect.skip",
					"effect.skipIf",
					"live",
					"live.each",
					"live.fails",
					"live.only",
					"live.prop",
					"live.runIf",
					"live.skip",
					"live.skipIf",
					"prop",
				],
			},
		],

		// Effect v4 and @alchemy.run/* modules are designed around namespace imports
		// (e.g. `import * as Effect from "effect/Effect"`).
		"import-x/no-namespace": "off",
		// tsconfig.base.json enables exactOptionalPropertyTypes with readonly object types;
		// conditional spreads (`...(v === undefined ? {} : { k: v })`) omit optional keys
		// without duplicating types into mutable builders.
		"quality/no-conditional-empty-object-spread": "off",
	},
	overrides: [
		...(cloudflare.overrides ?? []),
		{
			// Keep test-local helpers and deferred resolvers co-located inside their describe/it blocks.
			files: ["**/*.{test,spec}.{ts,tsx,mts,cts}"],
			rules: {
				"unicorn/consistent-function-scoping": "off",
			},
		},
		{
			// Test suites and test harnesses intentionally craft invalid/partial payloads
			// and narrow untyped test doubles (e.g. `res.json()`, corrupt snapshots).
			files: ["**/test/**/*.ts"],
			rules: {
				"quality/no-chained-type-assertions": "off",
				"typescript/no-unsafe-type-assertion": "off",
			},
		},
		{
			// @alchemy.run/domain's Z3 formal verifier symbolically evaluates predicate arrow
			// functions and does not model the global `Boolean` constructor.
			files: ["**/*.{aggregate,decision,model}.ts"],
			rules: {
				"unicorn/prefer-native-coercion-functions": "off",
			},
		},
		{
			// PiRefusals emits structured console.warn logs outside Effect for Cloudflare
			// Worker logs, and the refusal tests intercept console.warn to verify redaction.
			files: [
				"apps/api/src/Pi/PiRefusals.ts",
				"apps/api/test/Api.refusals.anthropic.test.ts",
				"apps/api/test/Api.refusals.openai.test.ts",
			],
			rules: {
				"no-console": "off",
			},
		},
		{
			// SnapshotMigrationStep chains heterogeneous versioned aggregate states across
			// arbitrary domain schemas where intermediate steps and the dynamic wire union
			// are intentionally type-erased at the codec boundary.
			files: ["packages/snapshots/src/VersionedSnapshot.ts"],
			rules: {
				"quality/no-chained-type-assertions": "off",
				"quality/no-unknown-returns": "off",
				"typescript/no-unsafe-type-assertion": "off",
			},
		},
		{
			// GeneratedRuntime dynamically decodes erased HttpApiEndpoint Schema.Top contracts
			// and dispatches Forge-generated operations onto the typed HttpApiClient by name.
			files: ["apps/cli/src/GeneratedRuntime.ts"],
			rules: {
				"quality/no-chained-type-assertions": "off",
				"typescript/no-unsafe-type-assertion": "off",
			},
		},
		{
			// The generated MCP tool manifest copies JSON Schema literals (numeric bounds,
			// regular-expression patterns) verbatim from the OpenAPI document.
			files: ["apps/mcp/src/generated/Tools.ts"],
			rules: {
				"unicorn/numeric-separators-style": "off",
				"unicorn/prefer-string-raw": "off",
			},
		},
		...OWNED.map(({ owner }) => ({ files: [owner], rules: confined(owner) })),
		{
			files: ["**/*.story.{test,spec}.ts"],
			rules: {
				"promise/valid-params": "off",
			},
		},
	],
})
