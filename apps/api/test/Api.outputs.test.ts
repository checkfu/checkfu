import { createHash } from "node:crypto"
import { SessionOutputs } from "@checkfu/domain/Outputs/SessionOutputs.aggregate"
import { SessionId } from "@checkfu/domain/Session/Session.id"
import { describe, expect, it } from "@effect/vitest"
import type * as Duration from "effect/Duration"
import type { RuntimeContext } from "alchemy/RuntimeContext"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import { FileStoreError } from "../src/Files/FileStore.ts"
import { OutputsSaveTimeout, makeOutputsSaver } from "../src/Files/OutputsSaverLive.ts"
import { makeApiHandler } from "../src/Http/Router.ts"
import {
	MAX_OUTPUT_FILES,
	MAX_OUTPUT_FILE_BYTES,
	MAX_OUTPUT_TOTAL_BYTES,
} from "../src/Workspace/SessionOutputs.ts"
import {
	AUTH_HEADERS,
	makeAssistantReply,
	makePiDurableTestLayer,
	sendAndSettle,
	sendRequest,
} from "./helpers/ApiHarness.ts"

type ApiFetch = Parameters<typeof sendRequest>[0]
type World = ReturnType<typeof makePiDurableTestLayer>

interface FileBody {
	readonly id: string
	readonly type: string
	readonly filename: string
	readonly content_type: string
	readonly size: number
	readonly sha256: string
	readonly origin: {
		readonly type: string
		readonly session_id?: string
		readonly turn?: number
		readonly path?: string
	}
	readonly created_at: string
}

interface OutputsBody {
	readonly type: string
	readonly session_id: string
	readonly turn: number
	readonly status: string
	readonly reason: string | null
	readonly files: ReadonlyArray<FileBody>
	readonly skipped: ReadonlyArray<{ readonly path: string; readonly reason: string }>
	readonly recorded_at: string | null
}

interface SessionBody {
	readonly id: string
}

const OUTPUTS = "/mnt/session/outputs"

const ATTEMPTS = 2
const SAVE_CUT_OFF = "400 millis"

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex")

const saved = (sessionId: string, turn: number, path: string, content: string, type: string) => ({
	id: expect.stringMatching(/^file_[0-9a-f]{32}$/),
	type: "file",
	filename: path.slice(path.lastIndexOf("/") + 1),
	content_type: type,
	size: Buffer.byteLength(content),
	sha256: sha256(content),
	origin: { type: "session", session_id: sessionId, turn, path },
	created_at: expect.any(String),
})

const request = (apiFetch: ApiFetch, method: string, path: string, body?: unknown) =>
	sendRequest(apiFetch, {
		method,
		path,
		headers: AUTH_HEADERS,
		...(body === undefined ? {} : { body }),
	})

const json = <A>(response: Response) => Effect.promise(() => response.json() as Promise<A>)

type Edit = (signal: AbortSignal | undefined) => void | "aborted" | Promise<void | "aborted">

const withSessions = async (
	run: (
		apiFetch: ApiFetch,
		world: Pick<
			World,
			| "executorLayer"
			| "workspaceFiles"
			| "fileStore"
			| "outputReads"
			| "outputWalks"
			| "setBeforeOutputsRead"
			| "savedTurns"
			| "saveOutputs"
			| "discardedWorkspaces"
		> & {
			readonly onTurn: (edit: Edit) => void
			readonly replyAndSave: (
				sessionId: string,
				input: ReadonlyArray<string>,
				turn: number,
			) => Effect.Effect<void>
			readonly createSession: Effect.Effect<SessionBody>
			readonly outputs: (sessionId: string) => Effect.Effect<OutputsBody>
			readonly replies: (sessionId: string) => Effect.Effect<ReadonlyArray<string>>
			readonly textOf: (fileId: string) => Effect.Effect<string>
		},
	) => Effect.Effect<void, never, RuntimeContext | Layer.Success<World["layer"]>>,
	saveTimeout: Duration.Input = "30 seconds",
) => {
	let edit: Edit = () => undefined
	const { layer, closeAll, ...world } = makePiDurableTestLayer(async (model, _context, signal) =>
		(await edit(signal)) === "aborted"
			? { ...makeAssistantReply(model, null, "", 0, 0), stopReason: "aborted" as const }
			: makeAssistantReply(model, null, "ok", 1, 1),
	)
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
					...world,
					replyAndSave: (sessionId, input, turn) =>
						Effect.gen(function* () {
							yield* sendAndSettle(apiFetch, sessionId, input, turn)
							while (!world.savedTurns.includes(`${sessionId}:${turn}`)) {
								yield* Effect.sleep("5 millis")
							}
						}),
					onTurn: (next) => {
						edit = next
					},
					createSession: Effect.flatMap(
						request(apiFetch, "POST", "/v1/sessions", {
							agent: agent.id,
							environment_id: environment.id,
						}),
						(res) => json<SessionBody>(res),
					),
					outputs: (sessionId) =>
						Effect.flatMap(request(apiFetch, "GET", `/v1/sessions/${sessionId}/outputs`), (res) =>
							json<OutputsBody>(res),
						),
					replies: (sessionId) =>
						Effect.map(
							Effect.flatMap(
								request(apiFetch, "GET", `/v1/sessions/${sessionId}/events?limit=100`),
								(res) =>
									json<{
										data: ReadonlyArray<{ type: string; content?: ReadonlyArray<{ text: string }> }>
									}>(res),
							),
							({ data }) =>
								data
									.filter((event) => event.type === "agent.message")
									.map((event) => event.content?.[0]?.text ?? ""),
						),
					textOf: (fileId) =>
						Effect.flatMap(request(apiFetch, "GET", `/v1/files/${fileId}/content`), (res) =>
							Effect.promise(() => res.text()),
						),
				})
			}).pipe(
				Effect.scoped,
				Effect.provide(
					layer.pipe(Layer.provideMerge(Layer.succeed(OutputsSaveTimeout, saveTimeout))),
				),
			),
		)
	} finally {
		await closeAll()
	}
}

describe("A session's outputs", () => {
	it("saves what a turn leaves in the outputs directory as files that say where they came from", () =>
		withSessions(
			(apiFetch, { replyAndSave, workspaceFiles, onTurn, createSession, outputs, textOf }) =>
				Effect.gen(function* () {
					const session = yield* createSession
					const report = "# Q3\n\nSales rose 12%.\n"
					const totals = "region,total\nEMEA,4217\n"
					onTurn(() => {
						workspaceFiles(session.id).set(`${OUTPUTS}/report.md`, report)
						workspaceFiles(session.id).set(`${OUTPUTS}/data/totals.csv`, totals)
						workspaceFiles(session.id).set("/workspace/notes.md", "private")
					})
					yield* replyAndSave(session.id, ["Write the report."], 1)

					const recorded = yield* outputs(session.id)
					expect(recorded).toEqual({
						type: "session_outputs",
						session_id: session.id,
						turn: 1,
						status: "saved",
						reason: null,
						files: [
							saved(session.id, 1, "data/totals.csv", totals, "text/csv"),
							saved(session.id, 1, "report.md", report, "text/markdown"),
						],
						skipped: [],
						recorded_at: expect.any(String),
					})
					const [csv, markdown] = recorded.files
					expect(yield* textOf(csv?.id ?? "")).toBe(totals)
					expect(yield* textOf(markdown?.id ?? "")).toBe(report)
					expect(
						yield* json(yield* request(apiFetch, "GET", `/v1/files/${markdown?.id ?? ""}`)),
					).toEqual(markdown)
				}),
		))

	it("answers with no record before a turn replies, and 404 for a session that does not exist", () =>
		withSessions((apiFetch, { createSession, outputs }) =>
			Effect.gen(function* () {
				const session = yield* createSession
				expect(yield* outputs(session.id)).toEqual({
					type: "session_outputs",
					session_id: session.id,
					turn: 0,
					status: "none",
					reason: null,
					files: [],
					skipped: [],
					recorded_at: null,
				})
				expect((yield* request(apiFetch, "GET", "/v1/sessions/sesn_missing/outputs")).status).toBe(
					404,
				)
			}),
		))

	it("keeps the file of a path that did not change, saves changed content as a new file, and drops a removed path", () =>
		withSessions(
			(
				apiFetch,
				{ replyAndSave, workspaceFiles, fileStore, onTurn, createSession, outputs, textOf },
			) =>
				Effect.gen(function* () {
					const session = yield* createSession
					const files = workspaceFiles(session.id)
					onTurn(() => {
						files.set(`${OUTPUTS}/a.txt`, "one")
						files.set(`${OUTPUTS}/b.txt`, "kept")
						files.set(`${OUTPUTS}/c.txt`, "gone soon")
					})
					yield* replyAndSave(session.id, ["Write them."], 1)
					const first = yield* outputs(session.id)
					expect(first.files.map((file) => file.origin.path)).toEqual(["a.txt", "b.txt", "c.txt"])
					expect(fileStore.writes()).toBe(3)

					onTurn(() => {
						files.set(`${OUTPUTS}/a.txt`, "two")
						files.delete(`${OUTPUTS}/c.txt`)
					})
					yield* replyAndSave(session.id, ["Change them."], 2)
					const second = yield* outputs(session.id)
					expect(second).toMatchObject({ turn: 2, status: "saved" })
					expect(second.files).toEqual([
						saved(session.id, 2, "a.txt", "two", "text/plain"),
						first.files[1],
					])
					expect(second.files[0]?.id).not.toBe(first.files[0]?.id)
					expect(fileStore.writes()).toBe(4)
					expect(yield* textOf(first.files[0]?.id ?? "")).toBe("one")
					expect(yield* textOf(first.files[2]?.id ?? "")).toBe("gone soon")

					onTurn(() => undefined)
					yield* replyAndSave(session.id, ["Thanks."], 3)
					expect(yield* outputs(session.id)).toMatchObject({ turn: 3, files: second.files })
					expect(fileStore.writes()).toBe(4)

					onTurn(() => void files.set(`${OUTPUTS}/a.txt`, "one"))
					yield* replyAndSave(session.id, ["Put it back."], 4)
					expect((yield* outputs(session.id)).files[0]).toEqual(first.files[0])
					expect(fileStore.writes()).toBe(4)
				}),
		))

	it("skips, by name, a file over the limit and the ones past the total, and saves the rest", () =>
		withSessions((apiFetch, { replyAndSave, workspaceFiles, onTurn, createSession, outputs }) =>
			Effect.gen(function* () {
				const session = yield* createSession
				const files = workspaceFiles(session.id)
				onTurn(() => {
					files.set(`${OUTPUTS}/big.bin`, "x".repeat(MAX_OUTPUT_FILE_BYTES + 1))
					files.set(`${OUTPUTS}/small.txt`, "fits")
				})
				yield* replyAndSave(session.id, ["Write them."], 1)
				expect(yield* outputs(session.id)).toMatchObject({
					turn: 1,
					status: "saved",
					files: [saved(session.id, 1, "small.txt", "fits", "text/plain")],
					skipped: [{ path: "big.bin", reason: `Larger than ${MAX_OUTPUT_FILE_BYTES} bytes.` }],
				})

				onTurn(() => {
					files.delete(`${OUTPUTS}/big.bin`)
					for (const name of ["a", "b", "c", "d"]) {
						files.set(`${OUTPUTS}/${name}.bin`, name.repeat(MAX_OUTPUT_FILE_BYTES))
					}
				})
				yield* replyAndSave(session.id, ["More."], 2)
				const second = yield* outputs(session.id)
				expect(second.files.map((file) => file.origin.path)).toEqual([
					"a.bin",
					"b.bin",
					"c.bin",
					"d.bin",
				])
				expect(second.skipped).toEqual([
					{
						path: "small.txt",
						reason: `The outputs total more than ${MAX_OUTPUT_TOTAL_BYTES} bytes.`,
					},
				])
			}),
		))

	it("retries the same captured output record and leaves exhausted writes to the policy", () =>
		withSessions(
			(_apiFetch, { createSession, executorLayer, workspaceFiles, outputWalks, outputs, textOf }) =>
				Effect.gen(function* () {
					const session = yield* createSession
					const args = { session_id: SessionId.make(session.id), turn: 1 }
					const files = workspaceFiles(session.id)
					files.set(`${OUTPUTS}/note.txt`, "before retry")
					const store = yield* SessionOutputs
					const recorded: Array<object> = []
					let permanentlyUnavailable = false
					const saver = yield* makeOutputsSaver.pipe(
						Effect.provide(executorLayer),
						Effect.provideService(SessionOutputs, {
							...store,
							send: (command, options) =>
								Effect.suspend(() => {
									recorded.push(command)
									if (recorded.length === 1 || permanentlyUnavailable) {
										files.set(`${OUTPUTS}/note.txt`, "after retry")
										return Effect.die(
											new Error("The outputs record store is temporarily unavailable"),
										)
									}
									return store.send(command, options)
								}),
						}),
					)
					yield* saver.save(args)
					expect(outputWalks).toHaveLength(1)
					expect(recorded).toHaveLength(2)
					expect(recorded[0]).toBe(recorded[1])
					const saved = yield* outputs(session.id)
					expect(saved).toMatchObject({ turn: 1, status: "saved" })
					const file = saved.files[0]
					if (file === undefined) {
						return yield* Effect.die(new Error("Expected a saved output"))
					}
					expect(yield* textOf(file.id)).toBe("before retry")

					permanentlyUnavailable = true
					expect(Exit.isFailure(yield* Effect.exit(saver.save({ ...args, turn: 2 })))).toBe(true)
					expect(recorded.slice(2)).toMatchObject([
						{ _tag: "RecordSessionOutputs" },
						{ _tag: "RecordSessionOutputs" },
					])
					expect((yield* store.get(args.session_id)).turn).toBe(1)
				}),
		))

	it("checks the final skip count before storing any files", () =>
		withSessions(
			(
				_apiFetch,
				{
					replyAndSave,
					workspaceFiles,
					onTurn,
					createSession,
					outputs,
					setBeforeOutputsRead,
					fileStore,
				},
			) =>
				Effect.gen(function* () {
					const session = yield* createSession
					const files = workspaceFiles(session.id)
					onTurn(() => {
						for (let index = 0; index < MAX_OUTPUT_FILES; index += 1) {
							files.set(`${OUTPUTS}/invalid\u0001-${index}.txt`, "ignore")
						}
						files.set(`${OUTPUTS}/first.txt`, "keep")
						files.set(`${OUTPUTS}/last.txt`, "old")
					})
					setBeforeOutputsRead(() => void files.set(`${OUTPUTS}/last.txt`, "changed size"))
					yield* replyAndSave(session.id, ["Write the outputs."], 1)
					expect(yield* outputs(session.id)).toMatchObject({
						turn: 1,
						status: "skipped",
						reason: `${MAX_OUTPUT_FILES + 1} outputs could not be saved.`,
						files: [],
					})
					expect(fileStore.writes()).toBe(0)
				}),
		))

	it("skips the turn and says why, keeping the files saved before, when the directory cannot be read as one", () =>
		withSessions(
			(apiFetch, { replyAndSave, workspaceFiles, outputWalks, onTurn, createSession, outputs }) =>
				Effect.gen(function* () {
					const session = yield* createSession
					const files = workspaceFiles(session.id)
					onTurn(() => void files.set(`${OUTPUTS}/a.txt`, "one"))
					yield* replyAndSave(session.id, ["Write it."], 1)
					const first = yield* outputs(session.id)

					onTurn(() => {
						for (let index = 0; index <= MAX_OUTPUT_FILES; index++) {
							files.set(`${OUTPUTS}/many/${index}.txt`, "x")
						}
					})
					yield* replyAndSave(session.id, ["Write many."], 2)
					expect(yield* outputs(session.id)).toEqual({
						...first,
						turn: 2,
						status: "skipped",
						reason: `${MAX_OUTPUT_FILES + 2} files; the limit is ${MAX_OUTPUT_FILES}.`,
						recorded_at: expect.any(String),
					})

					onTurn(() => {
						for (const path of Array.from(files.keys())) {
							if (path.startsWith(OUTPUTS)) {
								files.delete(path)
							}
						}
						files.set(OUTPUTS, "not a folder")
					})
					const walks = outputWalks.length
					yield* replyAndSave(session.id, ["Break it."], 3)
					expect(yield* outputs(session.id)).toMatchObject({
						turn: 3,
						status: "skipped",
						reason: `${OUTPUTS} is a file, not a directory.`,
						files: first.files,
					})
					expect(outputWalks).toHaveLength(walks + 1)
				}),
		))

	it("skips the turn rather than drop a name when more outputs are skipped than a record can hold", () =>
		withSessions((apiFetch, { replyAndSave, workspaceFiles, onTurn, createSession, outputs }) =>
			Effect.gen(function* () {
				const session = yield* createSession
				const files = workspaceFiles(session.id)
				onTurn(() => {
					for (let index = 0; index < MAX_OUTPUT_FILES; index++) {
						files.set(`${OUTPUTS}/bad\u0001${index}`, "x")
					}
					files.set(`${OUTPUTS}/${"n".repeat(300)}`, "x")
					files.set(`${OUTPUTS}/fine.txt`, "x")
				})
				yield* replyAndSave(session.id, ["Write them."], 1)
				expect(yield* outputs(session.id)).toMatchObject({
					turn: 1,
					status: "skipped",
					reason: `${MAX_OUTPUT_FILES + 1} outputs could not be saved.`,
					files: [],
					skipped: [],
				})

				onTurn(() => {
					for (let index = 1; index < MAX_OUTPUT_FILES; index++) {
						files.delete(`${OUTPUTS}/bad\u0001${index}`)
					}
				})
				yield* replyAndSave(session.id, ["Fewer."], 2)
				expect(yield* outputs(session.id)).toMatchObject({
					turn: 2,
					status: "saved",
					files: [saved(session.id, 2, "fine.txt", "x", "text/plain")],
					skipped: [
						{ path: "bad?0", reason: "This path is not allowed." },
						{ path: "n".repeat(300), reason: "Its name is too long for a file." },
					],
				})
			}),
		))

	it("records nothing for a turn that failed, and saves what it left once a turn replies", () =>
		withSessions(
			(
				apiFetch,
				{ replyAndSave, workspaceFiles, savedTurns, onTurn, createSession, outputs, replies },
			) =>
				Effect.gen(function* () {
					const session = yield* createSession
					const files = workspaceFiles(session.id)
					onTurn(() => {
						files.set(`${OUTPUTS}/a.txt`, "unfinished")
						throw new Error("provider down")
					})
					yield* sendAndSettle(apiFetch, session.id, ["Write it."], 1)
					yield* Effect.sleep("50 millis")
					expect(savedTurns).toEqual([])
					expect(yield* outputs(session.id)).toMatchObject({ turn: 0, status: "none", files: [] })

					onTurn(() => undefined)
					yield* replyAndSave(session.id, ["Again."], 2)
					expect(yield* replies(session.id)).toEqual(["ok"])
					expect(yield* outputs(session.id)).toMatchObject({
						turn: 2,
						status: "saved",
						files: [saved(session.id, 2, "a.txt", "unfinished", "text/plain")],
					})
				}),
		))

	it("leaves the turn successful when storage fails, records why, and saves at the next turn", () =>
		withSessions(
			(
				apiFetch,
				{ replyAndSave, workspaceFiles, fileStore, onTurn, createSession, outputs, replies },
			) =>
				Effect.gen(function* () {
					const session = yield* createSession
					onTurn(() => void workspaceFiles(session.id).set(`${OUTPUTS}/a.txt`, "kept"))
					let writes = 0
					fileStore.setBeforeStore(Effect.sync(() => void (writes += 1)))
					fileStore.setFailing(true)
					yield* replyAndSave(session.id, ["Write it."], 1)
					expect(yield* replies(session.id)).toEqual(["ok"])
					expect(fileStore.objects.size).toBe(0)
					expect(writes).toBe(0)
					expect(yield* outputs(session.id)).toMatchObject({
						turn: 1,
						status: "skipped",
						reason: "The outputs could not be saved.",
						files: [],
					})

					fileStore.setFailing(false)
					onTurn(() => undefined)
					yield* replyAndSave(session.id, ["Thanks."], 2)
					expect(yield* outputs(session.id)).toMatchObject({
						turn: 2,
						status: "saved",
						reason: null,
						files: [saved(session.id, 2, "a.txt", "kept", "text/plain")],
					})
					expect(writes).toBe(1)
				}),
		))

	it("retries a save when the store fails once", () =>
		withSessions(
			(apiFetch, { replyAndSave, workspaceFiles, fileStore, onTurn, createSession, outputs }) =>
				Effect.gen(function* () {
					const session = yield* createSession
					onTurn(() => void workspaceFiles(session.id).set(`${OUTPUTS}/a.txt`, "kept"))
					let attempts = 0
					fileStore.setBeforeStore(
						Effect.suspend(() => {
							attempts += 1
							return attempts === 1
								? Effect.fail(new FileStoreError({ cause: "write failed" }))
								: Effect.void
						}),
					)
					yield* replyAndSave(session.id, ["Write it."], 1)
					expect(attempts).toBe(ATTEMPTS)
					expect(yield* outputs(session.id)).toMatchObject({
						turn: 1,
						status: "saved",
						files: [saved(session.id, 1, "a.txt", "kept", "text/plain")],
					})
				}),
		))

	it("commits the reply without waiting for its outputs, and records a save that stalls as skipped", () =>
		withSessions(
			(
				apiFetch,
				{
					replyAndSave,
					workspaceFiles,
					fileStore,
					savedTurns,
					onTurn,
					createSession,
					outputs,
					replies,
				},
			) =>
				Effect.gen(function* () {
					const session = yield* createSession
					onTurn(() => void workspaceFiles(session.id).set(`${OUTPUTS}/a.txt`, "kept"))
					fileStore.setBeforeStore(Effect.never)
					yield* sendAndSettle(apiFetch, session.id, ["Write it."], 1)
					expect(yield* replies(session.id)).toEqual(["ok"])
					expect(savedTurns).toEqual([])
					while (savedTurns.length === 0) {
						yield* Effect.sleep("5 millis")
					}
					expect(yield* outputs(session.id)).toMatchObject({
						turn: 1,
						status: "skipped",
						reason: "Saving the outputs took too long.",
						files: [],
					})

					fileStore.setBeforeStore(Effect.void)
					onTurn(() => undefined)
					yield* replyAndSave(session.id, ["Thanks."], 2)
					expect(yield* outputs(session.id)).toMatchObject({
						turn: 2,
						status: "saved",
						files: [saved(session.id, 2, "a.txt", "kept", "text/plain")],
					})
				}),
			SAVE_CUT_OFF,
		))

	it("skips a turn whose workspace a later turn has entered, and records a turn only once", () =>
		withSessions(
			(
				apiFetch,
				{ replyAndSave, workspaceFiles, fileStore, saveOutputs, onTurn, createSession, outputs },
			) =>
				Effect.gen(function* () {
					const session = yield* createSession
					const files = workspaceFiles(session.id)
					onTurn(() => void files.set(`${OUTPUTS}/a.txt`, "one"))
					yield* replyAndSave(session.id, ["Write it."], 1)
					const first = yield* outputs(session.id)

					yield* saveOutputs({ session_id: SessionId.make(session.id), turn: 1 })
					expect(yield* outputs(session.id)).toEqual(first)
					expect(fileStore.writes()).toBe(1)

					onTurn(() => {
						files.set(`${OUTPUTS}/a.txt`, "unfinished")
						throw new Error("provider down")
					})
					yield* sendAndSettle(apiFetch, session.id, ["Change it."], 2)
					yield* sendAndSettle(apiFetch, session.id, ["Again."], 3)
					yield* saveOutputs({ session_id: SessionId.make(session.id), turn: 2 })
					expect(yield* outputs(session.id)).toMatchObject({
						turn: 2,
						status: "skipped",
						reason: "A later turn started before the outputs were read.",
						files: first.files,
					})
					expect(fileStore.writes()).toBe(1)
				}),
		))

	it("leaves a deleted output out, and does not save that content again", () =>
		withSessions(
			(apiFetch, { replyAndSave, workspaceFiles, fileStore, onTurn, createSession, outputs }) =>
				Effect.gen(function* () {
					const session = yield* createSession
					const files = workspaceFiles(session.id)
					onTurn(() => {
						files.set(`${OUTPUTS}/a.txt`, "one")
						files.set(`${OUTPUTS}/b.txt`, "two")
					})
					yield* replyAndSave(session.id, ["Write them."], 1)
					const first = yield* outputs(session.id)
					const deleted = first.files[0]?.id ?? ""
					expect((yield* request(apiFetch, "DELETE", `/v1/files/${deleted}`)).status).toBe(200)
					expect((yield* outputs(session.id)).files).toEqual([first.files[1]])

					onTurn(() => undefined)
					yield* replyAndSave(session.id, ["Thanks."], 2)
					expect(yield* outputs(session.id)).toMatchObject({
						turn: 2,
						files: [first.files[1]],
						skipped: [{ path: "a.txt", reason: "Its saved file was deleted." }],
					})
					expect(fileStore.writes()).toBe(2)

					onTurn(() => void files.set(`${OUTPUTS}/a.txt`, "one again"))
					yield* replyAndSave(session.id, ["Change it."], 3)
					expect((yield* outputs(session.id)).files.map((file) => file.origin)).toEqual([
						{ type: "session", session_id: session.id, turn: 3, path: "a.txt" },
						{ type: "session", session_id: session.id, turn: 1, path: "b.txt" },
					])
				}),
		))

	it("reads the files it lacks in calls that stay within the read budget", () =>
		withSessions((apiFetch, { replyAndSave, workspaceFiles, outputReads, onTurn, createSession }) =>
			Effect.gen(function* () {
				const session = yield* createSession
				onTurn(() => {
					for (const name of ["a", "b", "c"]) {
						workspaceFiles(session.id).set(`${OUTPUTS}/${name}.txt`, name.repeat(990_000))
					}
				})
				yield* replyAndSave(session.id, ["Write them."], 1)
				expect(outputReads.map((read) => read.paths)).toEqual([["a.txt", "b.txt"], ["c.txt"]])
			}),
		))

	it("saves a reply's outputs before an archive right after it discards the workspace", () =>
		withSessions(
			(
				apiFetch,
				{
					workspaceFiles,
					setBeforeOutputsRead,
					discardedWorkspaces,
					onTurn,
					createSession,
					outputs,
				},
			) =>
				Effect.gen(function* () {
					const session = yield* createSession
					onTurn(() => void workspaceFiles(session.id).set(`${OUTPUTS}/a.txt`, "last words"))
					setBeforeOutputsRead(
						() =>
							new Promise((resolve) => {
								setTimeout(resolve, 200)
							}),
					)
					yield* sendAndSettle(apiFetch, session.id, ["Write it."], 1)
					expect(
						(yield* request(apiFetch, "POST", `/v1/sessions/${session.id}/archive`)).status,
					).toBe(200)
					while (!discardedWorkspaces.includes(session.id)) {
						yield* Effect.sleep("5 millis")
					}
					expect(yield* outputs(session.id)).toMatchObject({
						turn: 1,
						status: "saved",
						files: [saved(session.id, 1, "a.txt", "last words", "text/plain")],
					})
				}),
		))
})
