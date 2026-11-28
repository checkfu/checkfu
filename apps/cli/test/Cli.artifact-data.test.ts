import { NOT_FOUND_EXIT_CODE, USAGE_EXIT_CODE } from "../src/Errors.ts"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { makeTestServer } from "./helpers/CliHarness.ts"

const parsed = <A>(result: { readonly stdout: string }) => JSON.parse(result.stdout) as A

describe("CLI artifact data", () => {
	it.live("round-trips JSON values and refuses lossy documents before writing", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const cli = yield* makeTestServer()
				const created = yield* cli.run(["artifacts", "create"], {
					stdin: '{"name":"Document fixture","files":[{"path":"index.html","content":"fixture"}]}',
				})
				const reference = [
					"--artifact-id",
					parsed<{ id: string }>(created).id,
					"--collection",
					"records",
					"--document-id",
					"example",
				]
				const put = ["artifacts:data", "put", ...reference]
				const retrieve = ["artifacts:data", "retrieve", ...reference]
				const expected = { date: "2026-11-28", child: ["café", false, null, { n: 1.25 }] }
				const good = yield* cli.run(put, {
					stdin: "data:\n  date: 2026-11-28\n  child: [café, false, null, {n: 1.25}]\n",
				})
				expect(good.exitCode).toBe(0)
				expect(good.stderr).toBe("")
				expect(parsed<{ data: unknown }>(yield* cli.run(retrieve)).data).toEqual(expected)

				for (const [source, text, args, options] of [
					[
						"--data",
						String.raw`{"a":{"x":1,"\u0078":2}}`,
						[...put, "--data", String.raw`{"a":{"x":1,"\u0078":2}}`],
						{},
					],
					[
						"--data",
						"time: !!timestamp 2026-11-28",
						[...put, "--data", "time: !!timestamp 2026-11-28"],
						{},
					],
					[
						"--data",
						"bytes: !!binary SGVsbG8=",
						[...put, "--data", "@data.yaml"],
						{ files: { "data.yaml": "bytes: !!binary SGVsbG8=" } },
					],
					["stdin", "other: .inf", put, { stdin: "data: {other: .inf}" }],
					["stdin", "inner: {key: 1, key: 2}", put, { stdin: "data: {inner: {key: 1, key: 2}}" }],
					["stdin", "data: &self {cycle: *self}", put, { stdin: "data: &self {cycle: *self}" }],
					["stdin", '{"data":1e999}', put, { stdin: '{"data":1e999}' }],
					["stdin", "data: {true: 1}", put, { stdin: "data: {true: 1}" }],
					["stdin", "data: {value: !!bool 1}", put, { stdin: "data: {value: !!bool 1}" }],
				] as const) {
					let outbound = 0
					const result = yield* cli.run(args, {
						...options,
						interceptFetch: (next, request) => {
							outbound += 1
							return next(request)
						},
					})
					expect([source, result.exitCode, outbound]).toEqual([source, USAGE_EXIT_CODE, 0])
					expect(result.stdout).toBe("")
					expect(result.stderr).toContain(source)
					expect(result.stderr).not.toContain(text)
				}
				expect(parsed<{ data: unknown }>(yield* cli.run(retrieve)).data).toEqual(expected)
			}),
		),
	)

	it.live("adds, puts, reads, lists and deletes the documents in an artifact's database", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const cli = yield* makeTestServer()
				const created = yield* cli.run(["artifacts", "create"], {
					stdin: JSON.stringify({
						name: "Poll",
						files: [{ path: "index.html", content: "<h1>Poll</h1>" }],
					}),
				})
				const artifact = ["--artifact-id", parsed<{ id: string }>(created).id]
				const votes = [...artifact, "--collection", "votes"]

				const added = yield* cli.run([
					"artifacts:data",
					"add",
					...votes,
					"--data",
					'{"choice":"b","weight":2}',
				])
				expect(added.stderr).toBe("")
				expect(parsed(added)).toMatchObject({
					type: "artifact_document",
					collection: "votes",
					data: { choice: "b", weight: 2 },
				})

				const pinned = [...votes, "--document-id", "pinned"]
				const put = yield* cli.run(["artifacts:data", "put", ...pinned], {
					stdin: JSON.stringify({ data: ["a", 1, null] }),
				})
				expect(parsed(put)).toMatchObject({ id: "pinned", data: ["a", 1, null] })
				expect(
					parsed(yield* cli.run(["artifacts:data", "put", ...pinned, "--data", "plain text"])),
				).toMatchObject({ id: "pinned", data: "plain text" })
				expect(parsed(yield* cli.run(["artifacts:data", "retrieve", ...pinned]))).toMatchObject({
					data: "plain text",
				})

				const listed = parsed<{ data: ReadonlyArray<{ id: string }>; next_page: string | null }>(
					yield* cli.run(["artifacts:data", "list", ...votes, "--limit", "1"]),
				)
				expect(listed.data).toHaveLength(1)
				expect(listed.next_page).not.toBeNull()
				const rest = parsed<{ data: ReadonlyArray<{ id: string }> }>(
					yield* cli.run(["artifacts:data", "list", ...votes, "--page", listed.next_page ?? ""]),
				)
				expect(rest.data.map((document) => document.id)).toEqual(["pinned"])

				expect(parsed(yield* cli.run(["artifacts:data", "describe", ...artifact]))).toMatchObject({
					type: "artifact_database",
					collections: [{ name: "votes", documents: 2 }],
				})

				expect(parsed(yield* cli.run(["artifacts:data", "delete", ...pinned]))).toEqual({
					id: "pinned",
					type: "artifact_document_deleted",
				})
				const gone = yield* cli.run(["artifacts:data", "retrieve", ...pinned])
				expect(gone.exitCode).toBe(NOT_FOUND_EXIT_CODE)
				expect(gone.stderr).toContain("not found")
			}),
		),
	)
})
