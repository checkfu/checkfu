import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Schedule from "effect/Schedule"
import { makeApiHandler } from "../src/Http/Router.ts"
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

const idIn = (text: string) => /art_[0-9a-f]{32}/u.exec(text)?.[0] ?? ""

const withSessions = async (
	run: (
		apiFetch: ApiFetch,
		world: Pick<
			World,
			| "workspaceFiles"
			| "saveSessionArtifact"
			| "sessionArtifactSaves"
			| "runInWorld"
			| "artifactStore"
			| "fileStore"
		> & {
			readonly createSession: Effect.Effect<{ readonly id: string }>
			readonly save: (sessionId: string, name: string, directory: string) => Effect.Effect<string>
		},
	) => Effect.Effect<void>,
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
				yield* run(apiFetch, {
					...world,
					createSession: Effect.gen(function* () {
						const session = yield* json<{ id: string }>(
							yield* request(apiFetch, "POST", "/v1/sessions", {
								agent: agent.id,
								environment_id: environment.id,
							}),
						)
						const posted = yield* request(apiFetch, "POST", `/v1/sessions/${session.id}/events`, {
							events: [
								{ type: "user.message", content: [{ type: "text", text: "Save these files." }] },
							],
						})
						expect(posted.status).toBe(200)
						return session
					}),
					save: (sessionId, name, directory) =>
						Effect.map(
							Effect.promise(() => world.saveSessionArtifact(sessionId, 1, name, directory)),
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

describe("An artifact the agent saves", () => {
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
						saves.sessionFileSave(theirs.id, 1, "secret.txt", new TextEncoder().encode("secret")),
					)
					expect(stolen.ok).toBe(true)
					const refused = yield* run(
						saves.sessionArtifactSave(mine.id, 1, "Report", [
							{ path: "secret.txt", file_id: stolen.ok ? stolen.file_id : "" },
						]),
					)
					expect(refused).toEqual({
						ok: false,
						message: "secret.txt is not a file this session saved.",
					})
					expect(
						yield* run(
							saves.sessionArtifactSave(mine.id, 1, "Report", [
								{ path: "x.txt", file_id: "file_missing" },
							]),
						),
					).toEqual({ ok: false, message: "x.txt is not a file this session saved." })
					expect(
						yield* run(saves.sessionFileSave(mine.id, 1, "../up.txt", new Uint8Array(1))),
					).toMatchObject({ ok: false })
					expect(yield* run(saves.sessionArtifactSave(mine.id, 1, "", []))).toMatchObject({
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
					runInWorld(saves.sessionFileSave(session.id, 1, "assets/common.txt", contents)),
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
				expect(yield* run(saves.sessionFileSave(session.id, 0, "a.txt", new Uint8Array()))).toEqual(
					{
						ok: false,
						message: "Invalid session file save.",
					},
				)
				expect(yield* run(saves.sessionFileSave(session.id, 2, "a.txt", new Uint8Array()))).toEqual(
					{
						ok: false,
						message: "The turn is no longer running.",
					},
				)
				expect(
					yield* run(
						saves.sessionFileSave(session.id, 1, "a.txt", new Uint8Array(8 * 1024 * 1024 + 1)),
					),
				).toEqual({
					ok: false,
					message: "The file exceeds the artifact file size limit.",
				})
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
							runInWorld(saves.sessionFileSave(session.id, 1, "b.txt", new Uint8Array(1))),
						),
					).toEqual(ended)
					expect(
						yield* Effect.promise(() =>
							runInWorld(
								saves.sessionArtifactSave(session.id, 1, "Other", [
									{ path: "b.txt", file_id: "file_any" },
								]),
							),
						),
					).toEqual(ended)
				}),
		))
})
