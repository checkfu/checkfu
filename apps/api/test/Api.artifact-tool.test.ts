import { File } from "@checkfu/domain/File/File.aggregate"
import { FileId } from "@checkfu/domain/File/File.id"
import { SessionId } from "@checkfu/domain/Session/Session.id"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Schedule from "effect/Schedule"
import { FileStore } from "../src/Files/FileStore.ts"
import { SessionArtifactSaves } from "../src/SessionArtifactSaves.ts"
import { artifactData } from "../src/Workspace/ArtifactDataTool.ts"
import { makeApiHandler } from "../src/Http/Router.ts"
import { MAX_TOOL_ARTIFACT_FILES } from "../src/Workspace/SessionArtifactTool.ts"
import {
	AUTH_HEADERS,
	makeAssistantReply,
	makePiDurableTestLayer,
	sendRequest,
} from "./helpers/ApiHarness.ts"

type ApiFetch = Parameters<typeof sendRequest>[0]
type World = ReturnType<typeof makePiDurableTestLayer>

interface ArtifactBody {
	readonly id: string
	readonly name: string
	readonly version: number
	readonly files: ReadonlyArray<{ readonly path: string; readonly size: number }>
}

const request = (apiFetch: ApiFetch, method: string, path: string, body?: unknown) =>
	sendRequest(apiFetch, {
		method,
		path,
		headers: AUTH_HEADERS,
		...(body === undefined ? {} : { body }),
	})

const json = <A>(response: Response) => Effect.promise(() => response.json() as Promise<A>)

const captured = (path: string) => ({ directory: "/workspace", path })

const idIn = (text: string) => /art_[0-9a-f]{32}/u.exec(text)?.[0] ?? ""

const withSessions = async (
	run: (
		apiFetch: ApiFetch,
		world: Pick<
			World,
			| "artifactFiles"
			| "workspaceFiles"
			| "saveOutputs"
			| "saveSessionArtifact"
			| "sessionArtifactData"
			| "sessionArtifactSaves"
			| "runInWorld"
			| "artifactStore"
			| "fileStore"
		> & {
			readonly createSession: Effect.Effect<{ readonly id: string }>
			readonly createSessionResponse: (
				resources: ReadonlyArray<AttachedArtifact>,
			) => Effect.Effect<Response>
			readonly createSessionWith: (
				resources: ReadonlyArray<AttachedArtifact>,
			) => Effect.Effect<{ readonly id: string }>
			readonly save: (
				sessionId: string,
				name: string,
				directory: string,
				madeFrom?: string,
			) => Effect.Effect<string>
		},
	) => Effect.Effect<void, never, Effect.Services<typeof SessionArtifactSaves>>,
) => {
	const pending = Promise.withResolvers<void>()
	const { layer, closeAll, ...world } = makePiDurableTestLayer(async (model, _context, signal) => {
		await new Promise<void>((done) => {
			if (signal?.aborted) {
				done()
				return
			}
			const finish = () => {
				signal?.removeEventListener("abort", finish)
				done()
			}
			signal?.addEventListener("abort", finish, { once: true })
			void pending.promise.then(finish)
		})
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
				const createSessionResponse = (resources: ReadonlyArray<AttachedArtifact>) =>
					request(apiFetch, "POST", "/v1/sessions", {
						agent: agent.id,
						environment_id: environment.id,
						...(resources.length === 0 ? {} : { resources }),
					})
				const started = (resources: ReadonlyArray<AttachedArtifact>) =>
					Effect.gen(function* () {
						const session = yield* json<{ id: string }>(yield* createSessionResponse(resources))
						const posted = yield* request(apiFetch, "POST", `/v1/sessions/${session.id}/events`, {
							events: [
								{ type: "user.message", content: [{ type: "text", text: "Save these files." }] },
							],
						})
						expect(posted.status).toBe(200)
						return session
					})
				yield* run(apiFetch, {
					...world,
					createSessionResponse,
					createSession: started([]),
					createSessionWith: started,
					save: (sessionId, name, directory, madeFrom) =>
						Effect.map(
							Effect.promise(() =>
								world.saveSessionArtifact(sessionId, 1, name, directory, madeFrom),
							),
							(result) =>
								result.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
						),
				}).pipe(Effect.ensuring(Effect.sync(pending.resolve)))
			}).pipe(Effect.scoped, Effect.provide(layer)),
		)
	} finally {
		pending.resolve()
		await closeAll()
	}
}

interface AttachedArtifact {
	readonly type: "artifact"
	readonly artifact_id: string
	readonly version?: number
	readonly mount_path?: string
}

interface ToolReply {
	readonly id: string
	readonly data?: unknown
	readonly path?: string
	readonly next_page?: string | null
}

interface DataArguments {
	readonly collection: string
	readonly operation: string
	readonly id?: string
	readonly data?: unknown
	readonly key?: string
	readonly limit?: number
	readonly page?: string | null
}

it("keeps identical artifact and output files independent across turns", () =>
	withSessions(
		(apiFetch, { createSession, workspaceFiles, sessionArtifactSaves, runInWorld, saveOutputs }) =>
			Effect.gen(function* () {
				const session = yield* createSession
				const output = (turn: number) =>
					saveOutputs({ session_id: SessionId.make(session.id), turn }).pipe(
						Effect.andThen(request(apiFetch, "GET", `/v1/sessions/${session.id}/outputs`)),
						Effect.flatMap(
							json<{
								readonly files: ReadonlyArray<{
									id: string
									origin: { turn: number; path: string }
								}>
								readonly skipped: ReadonlyArray<unknown>
							}>,
						),
					)
				const contents = "same file"
				workspaceFiles(session.id).set("/mnt/session/outputs/index.html", contents)
				const save = (directory: string, path = "index.html") =>
					Effect.promise(() =>
						runInWorld(
							sessionArtifactSaves().sessionFileSave(
								session.id,
								1,
								{ directory, path },
								new TextEncoder().encode(contents),
							),
						),
					)
				const tool = yield* save("/workspace/site")
				const same = yield* save("/workspace/site")
				const other = yield* save("/workspace/other")
				const nested = yield* save("/workspace/site", "sub/index.html")
				const nestedRoot = yield* save("/workspace/site/sub")
				expect(nested).toMatchObject({ ok: true })
				expect(nestedRoot).toMatchObject({ ok: true })
				expect(nested).not.toEqual(nestedRoot)
				expect(same).toEqual(tool)
				expect(other).not.toEqual(tool)
				if (!tool.ok || !other.ok) {
					throw new Error("The artifact files were not saved.")
				}
				expect((yield* request(apiFetch, "DELETE", `/v1/files/${tool.file_id}`)).status).toBe(200)
				const first = yield* output(1)
				expect(first.skipped).toEqual([])
				expect(first.files).toMatchObject([{ origin: { turn: 1, path: "index.html" } }])
				expect(first.files[0]?.id).not.toBe(tool.file_id)
				expect(first.files[0]?.id).not.toBe(other.file_id)
				const next = yield* output(2)
				expect(next.files).toEqual(first.files)
				expect(next.skipped).toEqual([])
			}),
	))

describe("An artifact the agent saves", () => {
	it("mounts two artifacts with the same name at distinct chosen directories", () =>
		withSessions((apiFetch, { artifactFiles, createSessionResponse, createSessionWith }) =>
			Effect.gen(function* () {
				const create = (content: string) =>
					Effect.flatMap(
						request(apiFetch, "POST", "/v1/artifacts", {
							name: "Daily report",
							files: [{ path: "index.html", content }],
						}),
						json<{ readonly id: string }>,
					)
				const today = yield* create("Today")
				const yesterday = yield* create("Yesterday")
				const attachment = (artifact_id: string) => ({ type: "artifact" as const, artifact_id })
				const session = yield* createSessionWith([
					{ ...attachment(today.id), mount_path: "today" },
					{ ...attachment(yesterday.id), mount_path: "yesterday" },
				])
				const files = artifactFiles(session.id)
				expect(yield* Effect.promise(() => files.read("/mnt/artifacts/today/index.html"))).toBe(
					"Today",
				)
				expect(yield* Effect.promise(() => files.read("/mnt/artifacts/yesterday/index.html"))).toBe(
					"Yesterday",
				)

				const collision = yield* createSessionResponse([
					attachment(today.id),
					attachment(yesterday.id),
				])
				expect(collision.status).toBe(400)
				expect(yield* Effect.promise(() => collision.text())).toContain(
					"Expected mount paths that are neither equal nor inside one another",
				)
				const longest = "🙂".repeat(504)
				expect(
					(yield* createSessionResponse([{ ...attachment(today.id), mount_path: longest }])).status,
				).toBe(201)
				for (const mount_path of ["..", "/absolute", "nested/path", "../escape", `${longest}🙂`]) {
					expect(
						(yield* createSessionResponse([{ ...attachment(today.id), mount_path }])).status,
					).toBe(400)
				}
			}),
		))

	it("resolves each File once, checks every path, and keeps the storage-time guard", () =>
		withSessions((apiFetch, { createSession, sessionArtifactSaves, runInWorld }) =>
			Effect.gen(function* () {
				const session = yield* createSession
				const saves = sessionArtifactSaves()
				const seed = (path: string, data: string) =>
					Effect.gen(function* () {
						const saved = yield* Effect.promise(() =>
							runInWorld(
								saves.sessionFileSave(
									session.id,
									1,
									captured(path),
									new TextEncoder().encode(data),
								),
							),
						)
						if (!saved.ok) {
							throw new Error(saved.message)
						}
						return { path, file_id: saved.file_id }
					})
				const a = yield* seed("a.txt", "identical")
				const b = yield* seed("b.txt", "identical")
				expect(a.file_id).not.toBe(b.file_id)

				const owners = yield* File
				const reads: Array<string> = []
				let afterRead: ((file: string) => Effect.Effect<void>) | undefined
				const instrumented = SessionArtifactSaves.pipe(
					Effect.provideService(File, {
						...owners,
						get: (...args) => {
							const [target] = args
							const id = typeof target === "string" ? target : target.id
							reads.push(id)
							return owners.get(...args).pipe(Effect.tap(() => afterRead?.(id) ?? Effect.void))
						},
					}),
				)
				const observed = yield* instrumented
				const denied = yield* observed.sessionArtifactSave(
					session.id,
					1,
					"Report",
					[a, { ...a, path: "other.txt" }],
					"",
				)
				expect(denied).toEqual({
					ok: false,
					message: "other.txt is not a file this session saved.",
				})
				expect(reads.splice(0)).toEqual([a.file_id])
				const created = yield* observed.sessionArtifactSave(session.id, 1, "Report", [a, b], "")
				expect(created).toMatchObject({ ok: true, version: 1, changed: true, file_count: 2 })
				expect(reads.splice(0)).toEqual([a.file_id, b.file_id])

				const c = yield* seed("c.txt", "gone before copy")
				const storage = yield* FileStore
				const deleting = yield* instrumented.pipe(
					Effect.provideService(FileStore, {
						...storage,
						content: (file) =>
							Effect.gen(function* () {
								expect(file).toBe(c.file_id)
								expect((yield* request(apiFetch, "DELETE", `/v1/files/${file}`)).status).toBe(200)
								return yield* storage.content(file)
							}),
					}),
				)
				expect(yield* deleting.sessionArtifactSave(session.id, 1, "Report", [a, b, c], "")).toEqual(
					{
						ok: false,
						message: `File ${c.file_id} not found.`,
					},
				)
				expect(reads.splice(0)).toEqual([a.file_id, b.file_id, c.file_id])
				const replay = yield* observed.sessionArtifactSave(session.id, 1, "Report", [a, b], "")
				expect(replay).toEqual({ ...created, changed: false })
				expect(reads.splice(0)).toEqual([a.file_id, b.file_id])

				const overlapping = yield* seed("d.txt", "available during a concurrent delete")
				const id = FileId.make(overlapping.file_id)
				const retained = yield* Effect.orDie(storage.content(id))
				expect(retained).not.toBeNull()
				afterRead = (file) =>
					file === id
						? request(apiFetch, "DELETE", `/v1/files/${id}`).pipe(
								Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))),
								Effect.asVoid,
							)
						: Effect.void
				const pendingPurge = yield* instrumented.pipe(
					Effect.provideService(FileStore, {
						...storage,
						content: (file) => (file === id ? Effect.succeed(retained) : storage.content(file)),
					}),
				)
				expect(
					yield* pendingPurge.sessionArtifactSave(session.id, 1, "Overlap", [overlapping], ""),
				).toMatchObject({
					ok: true,
					version: 1,
					changed: true,
					file_count: 1,
				})
				expect(reads.splice(0)).toEqual([id])
				afterRead = undefined
				expect(
					yield* pendingPurge.sessionArtifactSave(session.id, 1, "After delete", [overlapping], ""),
				).toEqual({
					ok: false,
					message: `File ${id} not found.`,
				})
				expect(reads).toEqual([id])
			}),
		))

	it("holds the directory's files under the given name, and gains a version only when they change", () =>
		withSessions((apiFetch, { workspaceFiles, artifactStore, createSession, save }) =>
			Effect.gen(function* () {
				const session = yield* createSession
				const files = workspaceFiles(session.id)
				files.set("/workspace/site/index.html", "<h1>Q3</h1>")
				files.set("/workspace/site/assets/app.js", "start()")
				files.set("/workspace/notes.md", "private")

				const first = yield* save(session.id, "Q3 report", "/workspace/site")
				const id = idIn(first)
				expect(first).toBe(`Saved "Q3 report" as artifact ${id}, version 1, with 2 files.`)
				const artifact = yield* json<ArtifactBody>(
					yield* request(apiFetch, "GET", `/v1/artifacts/${id}`),
				)
				expect(artifact).toMatchObject({
					id,
					name: "Q3 report",
					version: 1,
					files: [
						{ path: "assets/app.js", size: 7 },
						{ path: "index.html", size: 11 },
					],
				})
				const page = yield* request(
					apiFetch,
					"GET",
					`/v1/artifacts/${id}/versions/1/content?file=index.html`,
				)
				expect(yield* Effect.promise(() => page.text())).toBe("<h1>Q3</h1>")

				expect(yield* save(session.id, "Q3 report", "/workspace/site")).toBe(
					`"Q3 report" is unchanged: artifact ${id} is still at version 1, with 2 files.`,
				)

				files.set("/workspace/site/index.html", "<h1>Q3, corrected</h1>")
				const blobs = () =>
					[...artifactStore.objects.keys()].filter((key) => key.includes(`${id}/blobs/`)).length
				expect(blobs()).toBe(2)
				expect(yield* save(session.id, "Q3 report", "/workspace/site")).toBe(
					`Saved "Q3 report" as artifact ${id}, version 2, with 2 files.`,
				)
				expect(blobs()).toBe(3)

				const other = yield* save(session.id, "Draft", "/workspace/site")
				expect(idIn(other)).not.toBe(id)
				expect(other).toContain("version 1")
				const listed = yield* Effect.flatMap(request(apiFetch, "GET", "/v1/artifacts"), (res) =>
					json<{ data: ReadonlyArray<ArtifactBody> }>(res),
				).pipe(
					Effect.repeat({
						schedule: Schedule.spaced("5 millis"),
						times: 200,
						until: (page) => page.data.length >= 2,
					}),
				)
				expect(listed.data.map((entry) => entry.name).toSorted()).toEqual(["Draft", "Q3 report"])
			}),
		))

	it("keeps each session's artifact of a name apart, and takes only files that session saved", () =>
		withSessions(
			(apiFetch, { workspaceFiles, sessionArtifactSaves, runInWorld, createSession, save }) =>
				Effect.gen(function* () {
					const mine = yield* createSession
					const theirs = yield* createSession
					workspaceFiles(mine.id).set("/workspace/out/a.txt", "mine")
					workspaceFiles(theirs.id).set("/workspace/out/a.txt", "theirs")
					const first = idIn(yield* save(mine.id, "Report", "/workspace/out"))
					const second = idIn(yield* save(theirs.id, "Report", "/workspace/out"))
					expect(first).not.toBe(second)

					const saves = sessionArtifactSaves()
					const run = <A>(effect: Effect.Effect<A>) => Effect.promise(() => runInWorld(effect))
					const stolen = yield* run(
						saves.sessionFileSave(
							theirs.id,
							1,
							captured("secret.txt"),
							new TextEncoder().encode("secret"),
						),
					)
					expect(stolen.ok).toBe(true)
					const refused = yield* run(
						saves.sessionArtifactSave(
							mine.id,
							1,
							"Report",
							[{ path: "secret.txt", file_id: stolen.ok ? stolen.file_id : "" }],
							"",
						),
					)
					expect(refused).toEqual({
						ok: false,
						message: "secret.txt is not a file this session saved.",
					})
					expect(
						yield* run(
							saves.sessionArtifactSave(
								mine.id,
								1,
								"Report",
								[{ path: "x.txt", file_id: "file_missing" }],
								"",
							),
						),
					).toEqual({ ok: false, message: "x.txt is not a file this session saved." })
					expect(
						yield* run(saves.sessionFileSave(mine.id, 1, captured("../up.txt"), new Uint8Array(1))),
					).toMatchObject({ ok: false })
					expect(yield* run(saves.sessionArtifactSave(mine.id, 1, "", [], ""))).toMatchObject({
						ok: false,
					})
				}),
		))

	it("gives each competing first save its own version and bytes", () =>
		withSessions((apiFetch, { artifactStore, createSession, workspaceFiles, save }) =>
			Effect.gen(function* () {
				const session = yield* createSession
				const files = workspaceFiles(session.id)
				files.set("/workspace/first/a.txt", "first")
				files.set("/workspace/second/a.txt", "second")

				const staged = Promise.withResolvers<void>()
				const resume = Promise.withResolvers<void>()
				let stages = 0
				artifactStore.setAfterStage(
					Effect.suspend(() => {
						stages += 1
						if (stages !== 2) {
							return Effect.void
						}
						staged.resolve()
						return Effect.promise(() => resume.promise)
					}),
				)
				const first = yield* Effect.forkChild(save(session.id, "Report", "/workspace/first"))
				const second = yield* Effect.gen(function* () {
					yield* Effect.promise(() => staged.promise)
					return yield* save(session.id, "Report", "/workspace/second")
				}).pipe(Effect.ensuring(Effect.sync(resume.resolve)))
				const id = idIn(second)
				expect(second).toContain(`as artifact ${id}, version 1`)
				expect(yield* Fiber.join(first)).toContain(`as artifact ${id}, version 2`)
				const content = yield* request(
					apiFetch,
					"GET",
					`/v1/artifacts/${id}/versions/1/content?file=a.txt`,
				)
				expect(yield* Effect.promise(() => content.text())).toBe("second")
			}),
		))

	it("shares a file reservation between concurrent saves of the same path and bytes", () =>
		withSessions((_apiFetch, { createSession, fileStore, runInWorld, sessionArtifactSaves }) =>
			Effect.gen(function* () {
				const session = yield* createSession
				const saves = sessionArtifactSaves()
				const contents = new TextEncoder().encode("shared")
				const save = Effect.promise(() =>
					runInWorld(saves.sessionFileSave(session.id, 1, captured("assets/common.txt"), contents)),
				)
				const firstStaged = Promise.withResolvers<void>()
				const secondStaged = Promise.withResolvers<void>()
				const resumeFirst = Promise.withResolvers<void>()
				const resumeSecond = Promise.withResolvers<void>()
				let staged = 0
				fileStore.setAfterPut(
					Effect.suspend(() => {
						staged += 1
						if (staged === 1) {
							firstStaged.resolve()
							return Effect.promise(() => resumeFirst.promise)
						}
						secondStaged.resolve()
						return Effect.promise(() => resumeSecond.promise)
					}),
				)
				const first = yield* Effect.forkChild(save)
				yield* Effect.promise(() => firstStaged.promise)
				const second = yield* Effect.forkChild(save)
				const winner = yield* Effect.gen(function* () {
					yield* Effect.promise(() => secondStaged.promise)
					resumeFirst.resolve()
					return yield* Fiber.join(first)
				}).pipe(Effect.ensuring(Effect.sync(resumeSecond.resolve)))
				expect(winner.ok).toBe(true)
				expect(yield* Fiber.join(second)).toEqual(winner)
			}),
		))

	it("saves a file again after a client deleted the copy saved before", () =>
		withSessions((apiFetch, { workspaceFiles, createSession, save }) =>
			Effect.gen(function* () {
				const session = yield* createSession
				workspaceFiles(session.id).set("/workspace/out/a.txt", "a")
				const id = idIn(yield* save(session.id, "Report", "/workspace/out"))
				const listed = yield* json<{ data: ReadonlyArray<{ id: string }> }>(
					yield* request(apiFetch, "GET", "/v1/files"),
				).pipe(
					Effect.repeat({
						schedule: Schedule.spaced("5 millis"),
						times: 200,
						until: (page) => page.data.length >= 1,
					}),
				)
				for (const file of listed.data) {
					expect((yield* request(apiFetch, "DELETE", `/v1/files/${file.id}`)).status).toBe(200)
				}
				expect(yield* save(session.id, "Report", "/workspace/out")).toBe(
					`"Report" is unchanged: artifact ${id} is still at version 1, with 1 file.`,
				)
				workspaceFiles(session.id).set("/workspace/out/b.txt", "b")
				expect(yield* save(session.id, "Report", "/workspace/out")).toBe(
					`Saved "Report" as artifact ${id}, version 2, with 2 files.`,
				)
			}),
		))

	it("does not register a file when the turn is interrupted during upload", () =>
		withSessions((apiFetch, { createSession, fileStore, workspaceFiles, save }) =>
			Effect.gen(function* () {
				const session = yield* createSession
				workspaceFiles(session.id).set("/workspace/out/a.txt", "some bytes")

				const storing = Promise.withResolvers<void>()
				const resume = Promise.withResolvers<void>()
				fileStore.setBeforeStore(
					Effect.sync(storing.resolve).pipe(Effect.andThen(Effect.promise(() => resume.promise))),
				)
				const saving = yield* Effect.forkChild(save(session.id, "Report", "/workspace/out"))
				yield* Effect.gen(function* () {
					yield* Effect.promise(() => storing.promise)
					const interrupted = yield* request(
						apiFetch,
						"POST",
						`/v1/sessions/${session.id}/events`,
						{
							events: [{ type: "user.interrupt" }],
						},
					)
					expect(interrupted.status).toBe(200)
				}).pipe(Effect.ensuring(Effect.sync(resume.resolve)))
				expect(yield* Fiber.join(saving)).toBe("The turn is no longer running.")
				const listed = yield* json<{ data: ReadonlyArray<unknown> }>(
					yield* request(apiFetch, "GET", "/v1/files"),
				)
				expect(listed.data).toEqual([])
			}),
		))

	it("refuses malformed, oversized, and stale save requests at the API boundary", () =>
		withSessions((_apiFetch, { createSession, runInWorld, sessionArtifactSaves }) =>
			Effect.gen(function* () {
				const session = yield* createSession
				const saves = sessionArtifactSaves()
				const run = <A>(effect: Effect.Effect<A>) => Effect.promise(() => runInWorld(effect))
				expect(
					yield* run(saves.sessionFileSave(session.id, 0, captured("a.txt"), new Uint8Array())),
				).toEqual({
					ok: false,
					message: "Invalid session file save.",
				})
				expect(
					yield* run(saves.sessionFileSave(session.id, 2, captured("a.txt"), new Uint8Array())),
				).toEqual({
					ok: false,
					message: "The turn is no longer running.",
				})
				expect(
					yield* run(
						saves.sessionFileSave(
							session.id,
							1,
							captured("a.txt"),
							new Uint8Array(8 * 1024 * 1024 + 1),
						),
					),
				).toEqual({
					ok: false,
					message: "The file exceeds the artifact file size limit.",
				})
			}),
		))

	it("records the capabilities a saved directory declares in its artifact.json", () =>
		withSessions((apiFetch, { workspaceFiles, createSession, save }) =>
			Effect.gen(function* () {
				const session = yield* createSession
				const files = workspaceFiles(session.id)
				files.set("/workspace/form/index.html", "<form></form>")
				files.set(
					"/workspace/form/artifact.json",
					JSON.stringify({
						capabilities: { database: { collections: { responses: { visitors: "add" } } } },
					}),
				)
				const id = idIn(yield* save(session.id, "Form", "/workspace/form"))
				const artifact = yield* json<{ capabilities: unknown }>(
					yield* request(apiFetch, "GET", `/v1/artifacts/${id}`),
				)
				expect(artifact.capabilities).toEqual({
					database: { collections: { responses: { visitors: "add" } } },
				})

				files.set("/workspace/form/artifact.json", "{ not json")
				expect(yield* save(session.id, "Form", "/workspace/form")).toBe(
					"artifact.json cannot be used: it is not JSON.",
				)
			}),
		))

	it("lets the agent read and write the data of an artifact it saved, in any collection", () =>
		withSessions((apiFetch, { workspaceFiles, createSession, save, sessionArtifactData }) =>
			Effect.gen(function* () {
				const session = yield* createSession
				const files = workspaceFiles(session.id)
				files.set("/workspace/board/index.html", "<h1>Numbers</h1>")
				files.set(
					"/workspace/board/artifact.json",
					JSON.stringify({
						capabilities: { database: { collections: { numbers: { visitors: "read" } } } },
					}),
				)
				const id = idIn(yield* save(session.id, "Dashboard", "/workspace/board"))
				const call = (args: unknown) =>
					Effect.map(
						Effect.promise(() => sessionArtifactData(session.id, 1, args)),
						(result) => ({
							error: result.isError,
							text: result.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
						}),
					)
				const done = (args: DataArguments) =>
					Effect.map(call({ name: "Dashboard", ...args }), ({ error, text }) => {
						expect(error ? text : "served").toBe("served")
						return JSON.parse(text) as ToolReply
					})

				const revenue = yield* done({
					collection: "numbers",
					operation: "put",
					id: "revenue",
					data: { q3: 1200, growth: 0.18 },
				})
				expect(revenue).toMatchObject({
					id: "revenue",
					type: "artifact_document",
					artifact_id: id,
					collection: "numbers",
					data: { q3: 1200, growth: 0.18 },
				})
				expect(yield* done({ collection: "numbers", operation: "get", id: "revenue" })).toEqual(
					revenue,
				)
				const added = yield* done({ collection: "notes", operation: "add", data: null })
				expect(added.data).toBeNull()
				yield* done({ collection: "numbers", operation: "add", data: [1, 2] })
				const first = yield* done({ collection: "numbers", operation: "list", limit: 1 })
				expect(first.data).toEqual([revenue])
				for (const limit of [undefined, 100]) {
					const list = yield* done({
						collection: "numbers",
						operation: "list",
						...(limit === undefined ? {} : { limit }),
					})
					expect(list.data).toHaveLength(2)
					expect(list.next_page).toBeNull()
				}
				const rest = yield* done({
					collection: "numbers",
					operation: "list",
					page: first.next_page ?? null,
				})
				expect(
					(rest.data as ReadonlyArray<{ data: unknown }>).map((document) => document.data),
				).toEqual([[1, 2]])
				expect(yield* done({ collection: "notes", operation: "delete", id: added.id })).toEqual({
					id: added.id,
					type: "artifact_document_deleted",
				})

				const seen = yield* json<{ data: ReadonlyArray<{ id: string }> }>(
					yield* request(apiFetch, "GET", `/v1/artifacts/${id}/data/numbers`),
				)
				expect(seen.data.map((document) => document.id)).toContain("revenue")
				yield* request(apiFetch, "PUT", `/v1/artifacts/${id}/data/numbers/revenue`, {
					data: "set by the owner",
				})
				expect((yield* done({ collection: "numbers", operation: "get", id: "revenue" })).data).toBe(
					"set by the owner",
				)

				const refusal = (args: unknown) =>
					Effect.map(call(args), ({ error, text }) => [error, text] as const)
				const numbers = { name: "Dashboard", collection: "numbers" }
				expect(yield* refusal({ ...numbers, operation: "get" })).toEqual([
					true,
					"get needs the document's id.",
				])
				expect(yield* refusal({ ...numbers, operation: "put", id: "a" })).toEqual([
					true,
					"put needs data: the JSON value to store.",
				])
				expect(yield* refusal({ ...numbers, operation: "get", id: "missing" })).toEqual([
					true,
					"Document missing not found in numbers.",
				])
				expect((yield* refusal({ ...numbers, operation: "get", id: "has.dot" }))[1]).toContain(
					"id must be",
				)
				expect(
					(yield* refusal({ name: "Dashboard", collection: "Numbers", operation: "list" }))[1],
				).toContain("collection must be")
				expect((yield* refusal({ ...numbers, operation: "everything" }))[1]).toContain(
					"artifact_data needs name",
				)
				expect(
					(yield* refusal({
						...numbers,
						operation: "put",
						id: "big",
						data: "x".repeat(70_000),
					}))[1],
				).toContain("at most 65536 bytes")
				expect(
					yield* refusal({ name: "Someone else's", collection: "numbers", operation: "list" }),
				).toEqual([
					true,
					'No artifact named "Someone else\'s" has been saved in this session. Save it with save_artifact first.',
				])

				for (const value of [false, 0, ""]) {
					expect(
						(yield* done({ collection: "flags", operation: "put", id: "falsy", data: value })).data,
					).toBe(value)
				}
				expect(
					(yield* refusal({
						...numbers,
						operation: "add",
						data: JSON.parse(`${"[".repeat(33)}1${"]".repeat(33)}`),
					}))[1],
				).toContain("nested at most 32 deep")
				for (const limit of [0, 101, 1.5]) {
					expect((yield* refusal({ ...numbers, operation: "list", limit }))[1]).toContain(
						"limit an integer from 1 to 100",
					)
				}
				for (const page of ["abc", "1e3", "-1", "007"]) {
					expect(yield* refusal({ ...numbers, operation: "list", page })).toEqual([
						true,
						"page must be the next_page of an earlier list.",
					])
				}

				for (const [name, bytes] of [
					["first", 15_000],
					["second", 15_000],
					["third", 15_000],
					["huge", 50_000],
					["last", 10],
				] as const) {
					yield* done({
						collection: "large",
						operation: "put",
						id: name,
						data: "x".repeat(bytes),
					})
				}
				const firstLarge = yield* done({ collection: "large", operation: "list", limit: 4 })
				expect(firstLarge.path).toMatch(/^\/mnt\/artifact-data-results\/.*\.json$/u)
				expect(firstLarge.next_page).toBeTypeOf("string")
				const full = JSON.parse(files.get(firstLarge.path ?? "") ?? "null") as {
					readonly data: ReadonlyArray<{ readonly id: string; readonly data: string }>
					readonly next_page: string | null
				}
				expect(full.next_page).toBe(firstLarge.next_page)
				expect(full.data.map(({ id, data }) => [id, data.length])).toEqual([
					["first", 15_000],
					["second", 15_000],
					["third", 15_000],
					["huge", 50_000],
				])
				const huge = yield* done({ collection: "large", operation: "get", id: "huge" })
				expect(huge).toMatchObject({ id: "huge" })
				expect(JSON.parse(files.get(huge.path ?? "") ?? "null")).toMatchObject({
					id: "huge",
					data: "x".repeat(50_000),
				})
				expect(
					(yield* done({
						collection: "large",
						operation: "list",
						page: firstLarge.next_page ?? null,
					})).data,
				).toMatchObject([{ id: "last" }])

				const original = {
					collection: "notes",
					operation: "add",
					data: "original",
					key: "submission",
				}
				const submitted = yield* done(original)
				yield* done({ collection: "notes", operation: "put", id: submitted.id, data: "edited" })
				expect(yield* done(original)).toMatchObject({ id: submitted.id, data: "edited" })
				expect(yield* refusal({ ...original, name: "Dashboard", data: "edited" })).toEqual([
					true,
					"Idempotency-Key was already used for a different request.",
				])

				const other = yield* createSession
				expect(
					(yield* Effect.promise(() =>
						sessionArtifactData(other.id, 1, { ...numbers, operation: "list" }),
					)).content,
				).toEqual([
					{
						type: "text",
						text: 'No artifact named "Dashboard" has been saved in this session. Save it with save_artifact first.',
					},
				])
				expect((yield* request(apiFetch, "DELETE", `/v1/artifacts/${id}`)).status).toBe(200)
				expect((yield* refusal({ ...numbers, operation: "list" }))[1]).toContain(
					"No artifact named",
				)
			}),
		))

	it("reuses the returned add key after a committed response is lost", () =>
		withSessions(
			(apiFetch, { createSession, workspaceFiles, save, runInWorld, sessionArtifactSaves }) =>
				Effect.gen(function* () {
					const session = yield* createSession
					workspaceFiles(session.id).set("/workspace/site/index.html", "report")
					const id = idIn(yield* save(session.id, "Report", "/workspace/site"))
					const data = { name: "Report", collection: "rows", operation: "add", data: "one" }
					const saves = sessionArtifactSaves()
					const firstKey = `pi:${session.id}:20`
					let committed: string | null = null
					const lost = yield* Effect.promise(() =>
						artifactData(data, {
							defaultKey: firstKey,
							writeResult: async () => {
								throw new Error("Unexpected large result")
							},
							ask: async (name, req) => {
								const result = await runInWorld(saves.sessionArtifactData(session.id, 1, name, req))
								if (result.ok) {
									committed = result.id
								}
								throw new Error("Lost the committed response")
							},
						}),
					)
					expect(committed).toBeTypeOf("string")
					expect(lost.content).toEqual([
						{
							type: "text",
							text: `The add could have succeeded. Repeat it with key "${firstKey}" to avoid another document.`,
						},
					])
					const retried = yield* Effect.promise(() =>
						artifactData(
							{ ...data, key: firstKey },
							{
								defaultKey: `pi:${session.id}:21`,
								writeResult: async () => {
									throw new Error("Unexpected large result")
								},
								ask: (name, req) => runInWorld(saves.sessionArtifactData(session.id, 1, name, req)),
							},
						),
					)
					expect(retried.isError).toBe(false)
					const rows = yield* json<{ data: ReadonlyArray<{ id: string }> }>(
						yield* request(apiFetch, "GET", `/v1/artifacts/${id}/data/rows`),
					)
					expect(rows.data.map((row) => row.id)).toEqual([committed])
					expect(retried.content).toEqual([
						{ type: "text", text: expect.stringContaining(JSON.stringify(committed)) },
					])
				}),
		))

	it("rejects invalid page sizes at the API binding and refuses writes from an interrupted turn", () =>
		withSessions(
			(apiFetch, { createSession, workspaceFiles, save, runInWorld, sessionArtifactSaves }) =>
				Effect.gen(function* () {
					const session = yield* createSession
					workspaceFiles(session.id).set("/workspace/site/index.html", "<main>Report</main>")
					const artifactId = idIn(yield* save(session.id, "Report", "/workspace/site"))
					const operations = sessionArtifactSaves()
					const requestData = {
						operation: "list" as const,
						collection: "notes",
						id: "",
						data: "",
						page: "",
						limit: -2,
						key: "",
					}
					const ask = (
						args:
							| typeof requestData
							| (Omit<typeof requestData, "operation"> & { operation: "put" }),
					) =>
						Effect.promise(() =>
							runInWorld(operations.sessionArtifactData(session.id, 1, "Report", args)),
						)
					expect(yield* ask(requestData)).toEqual({
						ok: false,
						message: "Invalid session artifact data call.",
					})
					expect(
						(yield* request(apiFetch, "POST", `/v1/sessions/${session.id}/events`, {
							events: [{ type: "user.interrupt" }],
						})).status,
					).toBe(200)
					expect(
						yield* ask({ ...requestData, operation: "put", limit: 0, id: "late", data: "null" }),
					).toEqual({ ok: false, message: "The turn is no longer running." })
					expect(
						(yield* request(apiFetch, "GET", `/v1/artifacts/${artifactId}/data/notes/late`)).status,
					).toBe(404)
				}),
		))

	it("makes an artifact from a type attached to the session, adding only the directory's content", () =>
		withSessions((apiFetch, { workspaceFiles, createSessionWith, save }) =>
			Effect.gen(function* () {
				const typeFiles = (page: string) => [
					{ path: "index.html", content: page },
					{ path: "README.md", content: "Put the text in content.md." },
					{
						path: "artifact.json",
						content: JSON.stringify({
							capabilities: { database: { collections: { comments: { visitors: "add" } } } },
						}),
					},
				]
				const type = yield* json<{ id: string }>(
					yield* request(apiFetch, "POST", "/v1/artifacts", {
						name: "document",
						files: typeFiles("page v1"),
					}),
				)
				const session = yield* createSessionWith([{ type: "artifact", artifact_id: type.id }])
				const files = workspaceFiles(session.id)
				files.set("/workspace/notes/content.md", "# Q3")

				const mount = "/mnt/artifacts/document"
				const first = yield* save(session.id, "Q3 notes", "/workspace/notes", `${mount}/`)
				const id = idIn(first)
				expect(first).toBe(`Saved "Q3 notes" as artifact ${id}, version 1, with 4 files.`)
				const made = yield* json<{
					files: ReadonlyArray<{ path: string }>
					capabilities: unknown
					made_from: unknown
				}>(yield* request(apiFetch, "GET", `/v1/artifacts/${id}`))
				expect(made.files.map((file) => file.path)).toEqual([
					"README.md",
					"artifact.json",
					"content.md",
					"index.html",
				])
				expect(made.made_from).toEqual({ artifact_id: type.id, version: 1 })
				expect(made.capabilities).toEqual({
					database: { collections: { comments: { visitors: "add" } } },
				})
				const page = yield* request(
					apiFetch,
					"GET",
					`/v1/artifacts/${id}/versions/1/content?file=index.html`,
				)
				expect(yield* Effect.promise(() => page.text())).toBe("page v1")
				expect(yield* save(session.id, "Q3 notes", "/workspace/notes", mount)).toContain(
					"is unchanged",
				)

				yield* request(apiFetch, "POST", `/v1/artifacts/${type.id}/versions`, {
					version: 1,
					files: typeFiles("page v2"),
				})
				files.set("/workspace/notes/content.md", "# Q3, revised")
				expect(yield* save(session.id, "Q3 notes", "/workspace/notes", mount)).toContain(
					"version 2",
				)
				const second = yield* request(
					apiFetch,
					"GET",
					`/v1/artifacts/${id}/versions/2/content?file=index.html`,
				)
				expect(yield* Effect.promise(() => second.text())).toBe("page v1")

				files.set("/workspace/clash/index.html", "<h1>mine</h1>")
				expect(yield* save(session.id, "Clash", "/workspace/clash", mount)).toContain(
					`index.html comes from artifact ${type.id} and cannot be replaced`,
				)
				files.set("/workspace/declares/artifact.json", "{}")
				expect(yield* save(session.id, "Declares", "/workspace/declares", mount)).toContain(
					"artifact.json is supplied by the source version",
				)
				expect(yield* save(session.id, "Other", "/workspace/notes", "/mnt/artifacts/slides")).toBe(
					"/mnt/artifacts/slides is not an artifact attached to this session. made_from takes the mount path of one, such as /mnt/artifacts/document.",
				)
				expect(yield* save(session.id, "Other", "/workspace/notes", "document")).toBe(
					"made_from must be the mount path of an attached artifact, for example /mnt/artifacts/document.",
				)
				expect(yield* save(session.id, "Plain", "/workspace/notes")).toContain("version 1")
				expect(
					(yield* json<{ made_from: unknown }>(
						yield* request(
							apiFetch,
							"GET",
							`/v1/artifacts/${idIn(yield* save(session.id, "Plain", "/workspace/notes"))}`,
						),
					)).made_from,
				).toBeNull()
			}),
		))

	it("copies the attached source when the session adds no files", () =>
		withSessions((apiFetch, { createSessionWith, runInWorld, sessionArtifactSaves }) =>
			Effect.gen(function* () {
				const { id } = yield* json<{ id: string }>(
					yield* request(apiFetch, "POST", "/v1/artifacts", {
						name: "template",
						files: [{ path: "index.html", content: "<main>Dashboard</main>" }],
					}),
				)
				const session = yield* createSessionWith([{ type: "artifact", artifact_id: id }])
				const result = yield* Effect.promise(() =>
					runInWorld(
						sessionArtifactSaves().sessionArtifactSave(
							session.id,
							1,
							"Dashboard",
							[],
							"/mnt/artifacts/template",
						),
					),
				)
				expect(result).toMatchObject({ ok: true, version: 1, file_count: 1, changed: true })
				if (result.ok) {
					const artifact = yield* json<ArtifactBody & { made_from: unknown }>(
						yield* request(apiFetch, "GET", `/v1/artifacts/${result.artifact_id}`),
					)
					expect(artifact.made_from).toEqual({ artifact_id: id, version: 1 })
					expect(artifact.files.map((file) => file.path)).toEqual(["index.html"])
				}
			}),
		))

	it("versions a save from a different attached source even when its files are identical", () =>
		withSessions((apiFetch, { createSessionWith, workspaceFiles, save }) =>
			Effect.gen(function* () {
				const first = yield* json<{ id: string }>(
					yield* request(apiFetch, "POST", "/v1/artifacts", {
						name: "template-a",
						files: [{ path: "index.html", content: "<main>Report</main>" }],
					}),
				)
				const second = yield* json<{ id: string }>(
					yield* request(apiFetch, "POST", "/v1/artifacts", {
						name: "template-b",
						files: [{ path: "index.html", content: "<main>Report</main>" }],
					}),
				)
				const session = yield* createSessionWith([
					{ type: "artifact", artifact_id: first.id },
					{ type: "artifact", artifact_id: second.id },
				])
				workspaceFiles(session.id).set("/workspace/out/content.md", "# Report")
				const id = idIn(
					yield* save(session.id, "Report", "/workspace/out", "/mnt/artifacts/template-a"),
				)
				expect(
					yield* save(session.id, "Report", "/workspace/out", "/mnt/artifacts/template-b"),
				).toBe(`Saved "Report" as artifact ${id}, version 2, with 2 files.`)
				const latest = yield* json<{ made_from: unknown }>(
					yield* request(apiFetch, "GET", `/v1/artifacts/${id}`),
				)
				expect(latest.made_from).toEqual({ artifact_id: second.id, version: 1 })
			}),
		))

	it("refuses a deleted attached source while its manifest still awaits erasure", () =>
		withSessions((apiFetch, { createSessionWith, workspaceFiles, artifactStore, save }) =>
			Effect.gen(function* () {
				const { id } = yield* json<{ id: string }>(
					yield* request(apiFetch, "POST", "/v1/artifacts", {
						name: "template",
						files: [{ path: "index.html", content: "<main>Report</main>" }],
					}),
				)
				const session = yield* createSessionWith([{ type: "artifact", artifact_id: id }])
				workspaceFiles(session.id).set("/workspace/out/content.md", "# Report")
				artifactStore.setBeforeDelete(Effect.sync(() => artifactStore.setFailing(true)))
				try {
					const deleted = yield* request(apiFetch, "DELETE", `/v1/artifacts/${id}`)
					expect(deleted.status).toBe(503)
					expect((yield* request(apiFetch, "GET", `/v1/artifacts/${id}`)).status).toBe(404)
					expect(
						[...artifactStore.objects.keys()].some((key) => key.includes(`/${id}/manifests/`)),
					).toBe(true)
					expect(
						yield* save(session.id, "Report", "/workspace/out", "/mnt/artifacts/template"),
					).toBe(`Artifact ${id} not found.`)
				} finally {
					artifactStore.setBeforeDelete(Effect.void)
					artifactStore.setFailing(false)
				}
			}),
		))

	it("counts files inherited from the attached source toward the artifact tool limit", () =>
		withSessions((apiFetch, { createSessionWith, workspaceFiles, save }) =>
			Effect.gen(function* () {
				const { id } = yield* json<{ id: string }>(
					yield* request(apiFetch, "POST", "/v1/artifacts", {
						name: "template",
						files: Array.from({ length: MAX_TOOL_ARTIFACT_FILES }, (_, index) => ({
							path: `file-${index}.txt`,
							content: "template",
						})),
					}),
				)
				const session = yield* createSessionWith([{ type: "artifact", artifact_id: id }])
				workspaceFiles(session.id).set("/workspace/out/content.md", "# Report")
				expect(yield* save(session.id, "Report", "/workspace/out", "/mnt/artifacts/template")).toBe(
					`An artifact holds 1 to ${MAX_TOOL_ARTIFACT_FILES} files.`,
				)
			}),
		))

	it("refuses to save once the artifact was deleted or the session has ended", () =>
		withSessions(
			(apiFetch, { workspaceFiles, sessionArtifactSaves, runInWorld, createSession, save }) =>
				Effect.gen(function* () {
					const session = yield* createSession
					workspaceFiles(session.id).set("/workspace/out/a.txt", "a")
					const id = idIn(yield* save(session.id, "Report", "/workspace/out"))
					expect((yield* request(apiFetch, "DELETE", `/v1/artifacts/${id}`)).status).toBe(200)
					expect(yield* save(session.id, "Report", "/workspace/out")).toBe(
						'The artifact named "Report" was deleted.',
					)

					expect(
						(yield* request(apiFetch, "POST", `/v1/sessions/${session.id}/archive`)).status,
					).toBe(200)
					const saves = sessionArtifactSaves()
					const ended = { ok: false, message: "The session has ended." }
					expect(
						yield* Effect.promise(() =>
							runInWorld(
								saves.sessionFileSave(session.id, 1, captured("b.txt"), new Uint8Array(1)),
							),
						),
					).toEqual(ended)
					expect(
						yield* Effect.promise(() =>
							runInWorld(
								saves.sessionArtifactSave(
									session.id,
									1,
									"Other",
									[{ path: "b.txt", file_id: "file_any" }],
									"",
								),
							),
						),
					).toEqual(ended)
				}),
		))
})
