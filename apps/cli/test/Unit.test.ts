import { describe, expect, it } from "@effect/vitest"
import * as ConfigProvider from "effect/ConfigProvider"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import * as YAML from "yaml"
import { makeCheckfuClient, normalizeApiUrl, resolveBaseUrl } from "../src/Client.ts"
import {
	escapeTerminalControlCharacters,
	stringifyTerminalSafeJson,
} from "../src/TerminalOutput.ts"
import { evaluateTransform, formatOutput } from "../src/Transform.ts"

describe("normalizeApiUrl", () => {
	it("accepts https URLs and loopback http URLs and strips trailing / and /v1", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				expect(yield* normalizeApiUrl("https://api.checkfu.com/")).toBe("https://api.checkfu.com")
				expect(yield* normalizeApiUrl("https://api.checkfu.com/v1/")).toBe(
					"https://api.checkfu.com",
				)
				expect(yield* normalizeApiUrl("https://api.checkfu.com/prefix/v1")).toBe(
					"https://api.checkfu.com/prefix",
				)
				expect(yield* normalizeApiUrl("http://localhost:1337/v1")).toBe("http://localhost:1337")
				expect(yield* normalizeApiUrl("http://127.0.0.1:8080/")).toBe("http://127.0.0.1:8080")
				expect(yield* normalizeApiUrl("http://[::1]:1337/v1/")).toBe("http://[::1]:1337")
			}),
		)
	})

	it("rejects non-loopback http, credentials, query, fragment, and bad schemes", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const cases = [
					"",
					"not-a-url",
					"http://api.example.com",
					"https://user:pass@api.example.com",
					"https://api.example.com?foo=bar",
					"https://api.example.com#frag",
					"ftp://api.example.com",
				]
				for (const bad of cases) {
					const err = yield* Effect.flip(normalizeApiUrl(bad))
					expect(err._tag).toBe("CliFailure")
					expect(err.exitCode).toBe(1)
				}

				const malformedWithCreds = yield* Effect.flip(
					normalizeApiUrl("https://alice:supersecret@badhost:99999"),
				)
				expect(malformedWithCreds.exitCode).toBe(1)
				expect(malformedWithCreds.message).not.toContain("alice")
				expect(malformedWithCreds.message).not.toContain("supersecret")
				expect(malformedWithCreds.message).not.toContain("badhost")
			}),
		)
	})

	it("backs off and fails after bounded retries when an SSE stream repeatedly closes mid-frame", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				let requests = 0
				const fakeFetch = (async () => {
					requests++
					return new Response('id: 1\nevent: user.message\ndata: {"partial', {
						status: 200,
						headers: { "content-type": "text/event-stream; charset=utf-8" },
					})
				}) as unknown as typeof globalThis.fetch

				const layer = Layer.mergeAll(
					FetchHttpClient.layer.pipe(
						Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fakeFetch)),
					),
					SecureRandom.layerWebCrypto,
					ConfigProvider.layer(ConfigProvider.fromUnknown({ CHECKFU_API_KEY: "ck_test" })),
				)

				const err = yield* Effect.gen(function* () {
					const client = yield* makeCheckfuClient(Option.some("http://localhost:1337"))
					return yield* Effect.flip(
						Stream.runDrain(
							client.streamSessionEvents("sess_test", {
								maxReconnectAttempts: 2,
								baseReconnectDelayMs: 5,
							}),
						),
					)
				}).pipe(Effect.provide(layer))

				expect(requests).toBe(3)
				expect(err.message).toContain("incomplete SSE frame")
			}),
		)
	})

	it("rejects explicitly blank --base-url instead of falling back to env vars or localhost", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const envLayer = ConfigProvider.layer(
					ConfigProvider.fromUnknown({
						CHECKFU_API_URL: "https://api.checkfu.com",
						CHECKFU_URL: "https://staging.checkfu.com",
					}),
				)
				expect(yield* resolveBaseUrl(Option.none()).pipe(Effect.provide(envLayer))).toBe(
					"https://api.checkfu.com",
				)
				for (const blank of ["", "   "]) {
					const err = yield* Effect.flip(
						resolveBaseUrl(Option.some(blank)).pipe(Effect.provide(envLayer)),
					)
					expect(err._tag).toBe("CliFailure")
					expect(err.message).toContain("must not be empty")
				}
			}),
		)
	})
})

describe("TerminalOutput", () => {
	it("escapes ANSI sequences, control chars, C1, line separators, and bidi overrides", () => {
		const dangerous = "hello\x1b]52;c;evil\x07\r\nworld\x7f\u009b31m\u202e\u2028ok\t!"
		const safe = escapeTerminalControlCharacters(dangerous)
		expect(safe).not.toContain("\x1b")
		expect(safe).not.toContain("\x07")
		expect(safe).not.toContain("\r")
		expect(safe).not.toContain("\x7f")
		expect(safe).not.toContain("\u009b")
		expect(safe).not.toContain("\u202e")
		expect(safe).not.toContain("\u2028")
		expect(safe).toContain("\\x1b]52;c;evil\\x07\nworld")
		expect(safe).toContain("ok\t!")
	})

	it("keeps JSON round-trip identical while escaping unsafe terminal code points", () => {
		const payload = { text: "hi\x1b[31m\u009b\u202e\u2028there" }
		const json = stringifyTerminalSafeJson(payload)
		expect(json).not.toContain("\x1b")
		expect(json).not.toContain("\u009b")
		expect(json).not.toContain("\u202e")
		expect(json).not.toContain("\u2028")
		expect(JSON.parse(json)).toEqual(payload)
	})
})

describe("Transform and formatOutput", () => {
	const sample = {
		id: "agt_123",
		name: "Helper",
		model: { id: "gpt-6.2-sol" },
		created_at: DateTime.makeUnsafe("2026-11-22T10:00:00.000Z"),
		data: [
			{ type: "user.message", content: [{ type: "text", text: "hi" }] },
			{ type: "agent.message", content: [{ type: "text", text: "hello" }] },
		],
	}

	it("evaluates GJSON-style paths, indices, counts, projections, and object/array literals", () => {
		expect(evaluateTransform(sample, "id")).toBe("agt_123")
		expect(evaluateTransform(sample, "model.id")).toBe("gpt-6.2-sol")
		expect(evaluateTransform(sample, "data.0.content.0.text")).toBe("hi")
		expect(evaluateTransform(sample, "data.-1.type")).toBe("agent.message")
		expect(evaluateTransform(sample, "data.#")).toBe(2)
		expect(evaluateTransform(sample, "data.#.type")).toEqual(["user.message", "agent.message"])
		expect(evaluateTransform(sample, "{id,model:model.id}")).toEqual({
			id: "agt_123",
			model: "gpt-6.2-sol",
		})
		expect(evaluateTransform(sample, "{id}.{id}")).toEqual({ id: "agt_123" })
		expect(evaluateTransform(sample, "{id,name}.id")).toBe("agt_123")
		expect(evaluateTransform(sample, "[id,name]")).toEqual(["agt_123", "Helper"])
		expect(evaluateTransform(sample, "[id,name].[0]")).toEqual(["agt_123"])
		expect(evaluateTransform(sample, "[id,name].1")).toBe("Helper")
		expect(evaluateTransform(sample, "missing.path")).toBeUndefined()
	})

	it("formats auto, json, pretty, yaml, raw, and DateTime.Utc cleanly", () => {
		expect(
			formatOutput(sample, {
				format: "auto",
				transform: Option.some("id"),
				rawOutput: true,
				isTerminal: false,
			}),
		).toBe("agt_123")

		expect(
			formatOutput(sample, {
				format: "json",
				transform: Option.some("created_at"),
				rawOutput: false,
				isTerminal: false,
			}),
		).toBe('"2026-11-22T10:00:00.000Z"')

		const yamlOut = formatOutput(sample, {
			format: "yaml",
			transform: Option.some("{id,model:model.id}"),
			rawOutput: false,
			isTerminal: false,
		})
		expect(yamlOut).toContain("id: agt_123")
		expect(yamlOut).toContain("model: gpt-6.2-sol")

		const prettyOut = formatOutput(
			{ a: 1 },
			{
				format: "auto",
				transform: Option.none(),
				rawOutput: false,
				isTerminal: true,
			},
		)
		expect(prettyOut).toBe('{\n  "a": 1\n}')

		const streamOut = formatOutput(
			{ a: 1 },
			{
				format: "auto",
				transform: Option.none(),
				rawOutput: false,
				isTerminal: true,
				streaming: true,
			},
		)
		expect(streamOut).toBe('{"a":1}')
	})

	it("preserves trailing newlines in YAML scalars and separates streamed YAML documents", () => {
		for (const scalar of ["hello\n\n", "\n\n", "trailing   ", { text: "body\n\n" }]) {
			const rendered = formatOutput(scalar, {
				format: "yaml",
				transform: Option.none(),
				rawOutput: false,
				isTerminal: false,
			})
			expect(YAML.parse(`${rendered}\n`)).toEqual(scalar)
		}

		const events = [
			{ id: "evt_1", seq: 1, type: "user.message", text: "first\n\n" },
			{ id: "evt_2", seq: 2, type: "agent.message", text: "second\n\n" },
		]
		const combined = events
			.map(
				(event) =>
					`${formatOutput(event, {
						format: "yaml",
						transform: Option.none(),
						rawOutput: false,
						isTerminal: false,
						streaming: true,
					})}\n`,
			)
			.join("")
		const docs = YAML.parseAllDocuments(combined)
		expect(docs).toHaveLength(2)
		for (const doc of docs) {
			expect(doc.errors).toEqual([])
		}
		expect(docs.map((doc) => doc.toJS())).toEqual(events)
	})
})
