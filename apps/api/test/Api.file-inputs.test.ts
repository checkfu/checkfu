import { MAX_SESSION_FILES } from "@checkfu/domain/Session/SessionResource"
import { describe, expect, it } from "@effect/vitest"
import { RuntimeContext } from "alchemy/RuntimeContext"
import * as Effect from "effect/Effect"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { makeApiHandler } from "../src/Http/Router.ts"
import {
	AUTH_HEADERS,
	TEST_RUNTIME,
	extractSystemText,
	makeAssistantReply,
	makePiDurableTestLayer,
	sendAndSettle,
	sendRequest,
} from "./helpers/ApiHarness.ts"

type ApiFetch = Parameters<typeof sendRequest>[0]
type World = ReturnType<typeof makePiDurableTestLayer>

interface ResourceBody {
	readonly id: string
	readonly type: string
	readonly file_id: string
	readonly size: number
	readonly sha256: string
	readonly mount_path: string
}

interface SessionBody {
	readonly id: string
	readonly resources: ReadonlyArray<ResourceBody>
}

const UPLOADS = "/mnt/session/uploads"

const request = (apiFetch: ApiFetch, method: string, path: string, body?: unknown) =>
	sendRequest(apiFetch, {
		method,
		path,
		headers: AUTH_HEADERS,
		...(body === undefined ? {} : { body }),
	})

const json = <A>(response: Response) => Effect.promise(() => response.json() as Promise<A>)

const withSessions = async (
	run: (
		apiFetch: ApiFetch,
		world: {
			readonly uploadedFiles: World["uploadedFiles"]
			readonly systems: Array<string>
			readonly onTurn: (look: () => Promise<void>) => void
			readonly createSession: (resources: ReadonlyArray<unknown>) => Effect.Effect<Response>
			readonly upload: (filename: string, content: string) => Effect.Effect<{ id: string }>
		},
	) => Effect.Effect<void>,
) => {
	const systems: Array<string> = []
	let look: () => Promise<void> = () => Promise.resolve()
	const { layer, closeAll, uploadedFiles } = makePiDurableTestLayer(async (model, context) => {
		systems.push(extractSystemText(context))
		await look()
		return makeAssistantReply(model, null, "ok", 1, 1)
	})
	try {
		await Effect.runPromise(
			Effect.gen(function* () {
				const { fetch: apiFetch } = yield* makeApiHandler
				const agent = yield* json<{ id: string }>(
					yield* request(apiFetch, "POST", "/v1/agents", { name: "Agent", model: "gpt-4o-mini" }),
				)
				const environment = yield* json<{ id: string }>(
					yield* request(apiFetch, "POST", "/v1/environments", { name: "Env" }),
				)
				yield* run(apiFetch, {
					uploadedFiles,
					systems,
					onTurn: (next) => {
						look = next
					},
					createSession: (resources) =>
						request(apiFetch, "POST", "/v1/sessions", {
							agent: agent.id,
							environment_id: environment.id,
							resources,
						}),
					upload: (filename, content) => {
						const bytes = new TextEncoder().encode(content)
						return Effect.flatMap(
							Effect.map(
								apiFetch.pipe(
									Effect.provideService(
										HttpServerRequest.HttpServerRequest,
										HttpServerRequest.fromWeb(
											new Request(
												`http://localhost/v1/files?filename=${encodeURIComponent(filename)}`,
												{
													method: "POST",
													headers: {
														...AUTH_HEADERS,
														"content-type": "application/octet-stream",
														"content-length": String(bytes.byteLength),
													},
													body: new Blob([bytes]),
												},
											),
										),
									),
									Effect.provideService(RuntimeContext, TEST_RUNTIME),
								),
								HttpServerResponse.toWeb,
							),
							(response) => json<{ id: string }>(response),
						)
					},
				})
			}).pipe(Effect.scoped, Effect.provide(layer)),
		)
	} finally {
		await closeAll()
	}
}

describe("Files in a session", () => {
	it("places each file read-only in the uploads directory and tells the agent where", () =>
		withSessions((apiFetch, { uploadedFiles, systems, onTurn, createSession, upload }) =>
			Effect.gen(function* () {
				const sales = "region,total\nEMEA,10\n"
				const csv = yield* upload("sales.csv", sales)
				const notes = yield* upload("notes.md", "Totals are in thousands.")
				const created = yield* createSession([
					{ type: "file", file_id: csv.id, mount_path: "data/q3.csv" },
					{ type: "file", file_id: notes.id },
				])
				expect(created.status).toBe(201)
				const session = yield* json<SessionBody>(created)
				expect(session.resources).toMatchObject([
					{
						id: expect.stringMatching(/^sesrsc_/),
						type: "file",
						file_id: csv.id,
						size: sales.length,
						sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
						mount_path: `${UPLOADS}/data/q3.csv`,
					},
					{ type: "file", file_id: notes.id, mount_path: `${UPLOADS}/notes.md` },
				])

				const seen: Array<{
					readonly files: ReadonlyArray<string>
					readonly sales: string | null
					readonly pages: ReadonlyArray<string | null>
					readonly notes: string | null
					readonly absent: string | null
				}> = []
				onTurn(async () => {
					const files = uploadedFiles(session.id)
					seen.push({
						files: await files.list(),
						sales: await files.read(`${UPLOADS}/data/q3.csv`),
						pages: [
							await files.read(`${UPLOADS}/data/q3.csv`, { offset: 13, length: 4 }),
							await files.read(`${UPLOADS}/data/q3.csv`, { offset: 100, length: 4 }),
						],
						notes: await files.read(`${UPLOADS}/notes.md`),
						absent: await files.read(`${UPLOADS}/other.txt`),
					})
				})
				yield* sendAndSettle(apiFetch, session.id, ["Sum the sales."], 1)
				expect(seen).toEqual([
					{
						files: [`${UPLOADS}/data/q3.csv`, `${UPLOADS}/notes.md`],
						sales,
						pages: ["EMEA", ""],
						notes: "Totals are in thousands.",
						absent: null,
					},
				])
				expect(systems[0]).toContain(
					`Files the user gave you, read-only. Read them with the read tool:\n- ${UPLOADS}/data/q3.csv (${sales.length} bytes)\n- ${UPLOADS}/notes.md (24 bytes)`,
				)

				const listed = yield* json<{ data: ReadonlyArray<ResourceBody> }>(
					yield* request(apiFetch, "GET", `/v1/sessions/${session.id}/resources`),
				)
				expect(listed.data.map((resource) => resource.mount_path)).toEqual([
					`${UPLOADS}/data/q3.csv`,
					`${UPLOADS}/notes.md`,
				])
			}),
		))

	it("shows an empty uploads directory to a session with no files", () =>
		withSessions((apiFetch, { uploadedFiles, systems, onTurn, createSession }) =>
			Effect.gen(function* () {
				const session = yield* json<SessionBody>(yield* createSession([]))
				let listed: ReadonlyArray<string> | undefined
				onTurn(async () => {
					listed = await uploadedFiles(session.id).list()
				})
				yield* sendAndSettle(apiFetch, session.id, ["Anything there?"], 1)
				expect(listed).toEqual([])
				expect(systems[0] ?? "").not.toContain("Files the user gave you")
			}),
		))

	it("refuses a file that is missing or deleted, a path taken twice, and more files than a session holds", () =>
		withSessions((apiFetch, { createSession, upload }) =>
			Effect.gen(function* () {
				const file = yield* upload("a.txt", "a")
				const other = yield* upload("b.txt", "b")
				const refusal = (resources: ReadonlyArray<unknown>) =>
					Effect.flatMap(createSession(resources), (res) =>
						Effect.map(json<{ error: { message: string } }>(res), ({ error }) => [
							res.status,
							error.message,
						]),
					)
				expect(yield* refusal([{ type: "file", file_id: "file_nope" }])).toEqual([
					404,
					"File file_nope not found.",
				])
				const mount = { type: "file", file_id: file.id }
				expect((yield* createSession([mount, mount])).status).toBe(400)
				expect(
					(yield* createSession([mount, { type: "file", file_id: other.id, mount_path: "a.txt" }]))
						.status,
				).toBe(400)
				expect(
					(yield* createSession([
						mount,
						{ type: "file", file_id: other.id, mount_path: "a.txt/inside.txt" },
					])).status,
				).toBe(400)
				expect((yield* createSession([{ ...mount, mount_path: "../escape.txt" }])).status).toBe(400)
				expect((yield* createSession([{ ...mount, mount_path: "/absolute.txt" }])).status).toBe(400)
				expect(
					(yield* createSession(
						Array.from({ length: MAX_SESSION_FILES + 1 }, (_, index) => ({
							...mount,
							mount_path: `copies/${index}.txt`,
						})),
					)).status,
				).toBe(400)
				expect(
					(yield* createSession(
						Array.from({ length: MAX_SESSION_FILES }, (_, index) => ({
							...mount,
							mount_path: `copies/${index}.txt`,
						})),
					)).status,
				).toBe(201)

				expect((yield* request(apiFetch, "DELETE", `/v1/files/${file.id}`)).status).toBe(200)
				expect(yield* refusal([mount])).toEqual([404, `File ${file.id} not found.`])
			}),
		))

	it("stops serving a file once it is deleted, without failing the session's turns", () =>
		withSessions((apiFetch, { uploadedFiles, onTurn, createSession, upload }) =>
			Effect.gen(function* () {
				const file = yield* upload("a.txt", "a")
				const session = yield* json<SessionBody>(
					yield* createSession([{ type: "file", file_id: file.id }]),
				)
				const seen: Array<string | null> = []
				onTurn(async () => {
					seen.push(
						await uploadedFiles(session.id)
							.read(`${UPLOADS}/a.txt`)
							.catch(() => "unavailable"),
					)
				})
				yield* sendAndSettle(apiFetch, session.id, ["Read it."], 1)
				expect((yield* request(apiFetch, "DELETE", `/v1/files/${file.id}`)).status).toBe(200)
				yield* sendAndSettle(apiFetch, session.id, ["Read it again."], 2)
				expect(seen).toEqual(["a", "unavailable"])
			}),
		))
})
