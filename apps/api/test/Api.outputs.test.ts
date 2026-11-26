import { createHash } from "node:crypto"
import { ArtifactVersionView } from "@checkfu/domain/Artifact/ArtifactVersionView.view"
import { Harness } from "@checkfu/domain/Session/Harness.external"
import { SessionId } from "@checkfu/domain/Session/Session.id"
import { describe, expect, it } from "@effect/vitest"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import {
	MAX_ARTIFACT_FILES,
	MAX_ARTIFACT_FILE_BYTES,
	MAX_ARTIFACT_TOTAL_BYTES,
} from "../src/Artifacts/ArtifactFiles.ts"
import { makeApiHandler } from "../src/Http/Router.ts"
import { HarnessTurnTimeout, OutputsPublishTimeout } from "../src/Pi/PiDurableHarness.ts"
import { DEFAULT_STORAGE_SCOPE as SCOPE } from "../src/Placement.ts"
import {
	AUTH_HEADERS,
	makeAssistantReply,
	makePiDurableTestLayer,
	sendAndSettle,
	sendRequest,
	waitForSession,
} from "./helpers/ApiHarness.ts"

type ApiFetch = Parameters<typeof sendRequest>[0]
type World = ReturnType<typeof makePiDurableTestLayer>

interface FileBody {
	readonly path: string
	readonly sha256: string
	readonly size: number
	readonly content_type: string
}

interface ArtifactBody {
	readonly id: string
	readonly type: string
	readonly name: string
	readonly version: number
	readonly file_count: number
	readonly total_bytes: number
	readonly files: ReadonlyArray<FileBody>
	readonly created_at: string
	readonly updated_at: string
	readonly publication: { readonly url: string } | null
}

interface SessionBody {
	readonly id: string
	readonly agent: { readonly id: string; readonly version: number }
	readonly environment_id: string
}

const OUTPUTS = "/mnt/session/outputs"

const WALK_LIMIT = 513
const ATTEMPTS = 2
const PUBLISH_CUT_OFF = "400 millis"
const STALLED_PUT = "1 second"
const SETTLE_DEADLINE = "500 millis"

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex")

const fileOf = (path: string, content: string, content_type: string): FileBody => ({
	path,
	sha256: sha256(content),
	size: Buffer.byteLength(content),
	content_type,
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
			| "workspaceFiles"
			| "artifactStore"
			| "outputReads"
			| "outputListReads"
			| "outputWalks"
			| "setBeforeOutputsRead"
			| "failingOutputReads"
			| "requests"
		> & {
			readonly onTurn: (edit: Edit) => void
			readonly warnings: Array<string>
			readonly harness: Harness["Service"]
			readonly createSession: (title?: string) => Effect.Effect<SessionBody>
			readonly outputs: (sessionId: string) => Effect.Effect<Response>
			readonly viewlessOutputs: (sessionId: string) => Effect.Effect<Response>
			readonly upload: (
				files: ReadonlyArray<{ readonly path: string; readonly content: string }>,
			) => Effect.Effect<Response>
			readonly replies: (sessionId: string) => Effect.Effect<ReadonlyArray<string>>
			readonly fileText: (
				artifactId: string,
				version: number,
				path: string,
			) => Effect.Effect<string>
		},
	) => Effect.Effect<void>,
	publishTimeout: Duration.Input = "30 seconds",
	turnTimeout?: Duration.Input,
) => {
	let edit: Edit = () => undefined
	const { layer, closeAll, ...world } = makePiDurableTestLayer(async (model, _context, signal) =>
		(await edit(signal)) === "aborted"
			? { ...makeAssistantReply(model, null, "", 0, 0), stopReason: "aborted" as const }
			: makeAssistantReply(model, null, "ok", 1, 1),
	)
	const warnings: Array<string> = []
	const captureWarnings = Logger.layer([
		Logger.make(({ logLevel, message }) => {
			if (logLevel === "Warn") {
				warnings.push(Array.isArray(message) ? message.join(" ") : String(message))
			}
		}),
	])
	try {
		await Effect.runPromise(
			Effect.gen(function* () {
				const { fetch: apiFetch } = yield* makeApiHandler
				const harness = yield* Harness
				const versions = yield* ArtifactVersionView
				const touched = () => Effect.die(new Error("a head read touched a view"))
				const viewless = yield* makeApiHandler.pipe(
					Effect.provideService(ArtifactVersionView, {
						...versions,
						get: touched,
						snapshot: touched,
						waitFor: touched,
						list: touched,
					}),
				)
				const agent = yield* json<{ id: string }>(
					yield* request(apiFetch, "POST", "/v1/agents", { name: "Agent", model: "gpt-4o-mini" }),
				)
				const environment = yield* json<{ id: string }>(
					yield* request(apiFetch, "POST", "/v1/environments", { name: "Env" }),
				)
				yield* run(apiFetch, {
					...world,
					warnings,
					harness,
					onTurn: (next) => {
						edit = next
					},
					createSession: (title) =>
						Effect.flatMap(
							request(apiFetch, "POST", "/v1/sessions", {
								agent: agent.id,
								environment_id: environment.id,
								...(title === undefined ? {} : { title }),
							}),
							(res) => json<SessionBody>(res),
						),
					outputs: (sessionId) => request(apiFetch, "GET", `/v1/sessions/${sessionId}/outputs`),
					viewlessOutputs: (sessionId) =>
						request(viewless.fetch, "GET", `/v1/sessions/${sessionId}/outputs`),
					upload: (files) => request(apiFetch, "POST", "/v1/artifacts", { name: "By hand", files }),
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
					fileText: (artifactId, version, path) =>
						Effect.map(
							Effect.flatMap(
								request(
									apiFetch,
									"GET",
									`/v1/artifacts/${artifactId}/versions/${version}/file?file=${encodeURIComponent(path)}`,
								),
								(res) => json<{ content: string }>(res),
							),
							({ content }) => content,
						),
				})
			}).pipe(
				Effect.scoped,
				Effect.provide(
					layer.pipe(
						Layer.provideMerge(captureWarnings),
						Layer.provideMerge(Layer.succeed(OutputsPublishTimeout, publishTimeout)),
						Layer.provideMerge(
							turnTimeout === undefined
								? Layer.empty
								: Layer.succeed(HarnessTurnTimeout, turnTimeout),
						),
					),
				),
			),
		)
	} finally {
		await closeAll()
	}
}

const keysOf = (store: World["artifactStore"]) =>
	[...store.objects.keys()].filter((key) => !key.includes("/delete-")).toSorted()

describe("A session's outputs", () => {
	it("publishes what a turn leaves in the outputs directory as version 1 of the session's artifact", () =>
		withSessions(
			(apiFetch, { workspaceFiles, artifactStore, onTurn, createSession, outputs, fileText }) =>
				Effect.gen(function* () {
					const session = yield* createSession()
					const report = "# Q3\n\nSales rose 12%.\n"
					const totals = "region,total\nEMEA,4217\n"
					onTurn(() => {
						workspaceFiles(session.id).set(`${OUTPUTS}/report.md`, report)
						workspaceFiles(session.id).set(`${OUTPUTS}/data/totals.csv`, totals)
					})
					yield* sendAndSettle(apiFetch, session.id, ["Write the report."], 1)

					const published = yield* outputs(session.id)
					expect(published.status).toBe(200)
					const artifact = yield* json<ArtifactBody>(published)
					const files = [
						fileOf("data/totals.csv", totals, "text/csv"),
						fileOf("report.md", report, "text/markdown"),
					]
					expect(artifact).toEqual({
						id: expect.stringMatching(/^art_[0-9a-f]{32}$/),
						type: "artifact",
						name: `Session ${session.id} outputs`,
						version: 1,
						file_count: 2,
						total_bytes: Buffer.byteLength(report) + Buffer.byteLength(totals),
						files,
						created_at: expect.any(String),
						updated_at: artifact.created_at,
						publication: null,
					})
					expect(
						yield* json(yield* request(apiFetch, "GET", `/v1/artifacts/${artifact.id}`)),
					).toEqual(artifact)
					expect(yield* fileText(artifact.id, 1, "report.md")).toBe(report)
					expect(yield* fileText(artifact.id, 1, "data/totals.csv")).toBe(totals)

					const uploaded = yield* json<ArtifactBody>(
						yield* request(apiFetch, "POST", "/v1/artifacts", {
							name: "By hand",
							files: [
								{ path: "report.md", content: report },
								{ path: "data/totals.csv", content: totals },
							],
						}),
					)
					expect(uploaded.files).toEqual(files)
					const stored = (id: string) =>
						keysOf(artifactStore)
							.filter((key) => key.startsWith(`artifacts/${SCOPE}/${id}/`))
							.map((key) => key.slice(`artifacts/${SCOPE}/${id}/`.length))
					expect(stored(artifact.id)).toHaveLength(3)
					expect(stored(artifact.id)).toEqual(stored(uploaded.id))

					const publishing = yield* request(
						apiFetch,
						"POST",
						`/v1/artifacts/${artifact.id}/publication`,
						{},
					)
					expect(publishing.status).toBe(200)
					const { publication } = yield* json<ArtifactBody>(publishing)
					expect(publication).toMatchObject({ url: expect.any(String) })
					expect(yield* json<ArtifactBody>(yield* outputs(session.id))).toMatchObject({
						publication,
					})
				}),
		))

	it("names the artifact after the session's title, and keeps each session's outputs apart", () =>
		withSessions((apiFetch, { workspaceFiles, onTurn, createSession, outputs }) =>
			Effect.gen(function* () {
				const titled = yield* createSession("Quarterly report")
				const other = yield* createSession("   ")
				onTurn(() => {
					workspaceFiles(titled.id).set(`${OUTPUTS}/a.txt`, "from the first")
					workspaceFiles(other.id).set(`${OUTPUTS}/a.txt`, "from the second")
				})
				yield* sendAndSettle(apiFetch, titled.id, ["Go."], 1)
				yield* sendAndSettle(apiFetch, other.id, ["Go."], 1)
				const first = yield* json<ArtifactBody>(yield* outputs(titled.id))
				const second = yield* json<ArtifactBody>(yield* outputs(other.id))
				expect(first.name).toBe("Quarterly report")
				expect(second.name).toBe(`Session ${other.id} outputs`)
				expect(first.id).not.toBe(second.id)
				expect(first.files).toEqual([fileOf("a.txt", "from the first", "text/plain")])
				expect(second.files).toEqual([fileOf("a.txt", "from the second", "text/plain")])
			}),
		))

	it("adds a version when a turn changes the outputs, stores only content the artifact lacks, and publishes nothing when nothing changed", () =>
		withSessions(
			(
				apiFetch,
				{ workspaceFiles, artifactStore, outputReads, onTurn, createSession, outputs, fileText },
			) =>
				Effect.gen(function* () {
					const session = yield* createSession()
					const files = workspaceFiles(session.id)
					const blobs = () =>
						keysOf(artifactStore)
							.filter((key) => key.includes("/blobs/"))
							.map((key) => key.slice(key.lastIndexOf("/") + 1))
					const manifests = () =>
						keysOf(artifactStore).filter((key) => key.includes("/manifests/")).length

					onTurn(() => {
						files.set(`${OUTPUTS}/index.html`, "<h1>Draft</h1>")
						files.set(`${OUTPUTS}/app.js`, "run()")
					})
					yield* sendAndSettle(apiFetch, session.id, ["Build the page."], 1)
					const first = yield* json<ArtifactBody>(yield* outputs(session.id))
					expect(first.version).toBe(1)
					expect(outputReads).toEqual([{ sessionId: session.id, paths: ["app.js", "index.html"] }])
					expect(blobs()).toEqual([sha256("<h1>Draft</h1>"), sha256("run()")].toSorted())

					onTurn(() => void files.set(`${OUTPUTS}/index.html`, "<h1>Final</h1>"))
					yield* sendAndSettle(apiFetch, session.id, ["Finish the page."], 2)
					const second = yield* json<ArtifactBody>(yield* outputs(session.id))
					expect(second).toMatchObject({
						id: first.id,
						version: 2,
						file_count: 2,
						files: [
							fileOf("app.js", "run()", "text/javascript"),
							fileOf("index.html", "<h1>Final</h1>", "text/html"),
						],
						created_at: first.created_at,
					})
					expect(outputReads.slice(1)).toEqual([{ sessionId: session.id, paths: ["index.html"] }])
					expect(blobs()).toEqual(
						[sha256("<h1>Draft</h1>"), sha256("<h1>Final</h1>"), sha256("run()")].toSorted(),
					)
					expect(manifests()).toBe(2)
					expect(yield* fileText(first.id, 1, "index.html")).toBe("<h1>Draft</h1>")
					expect(yield* fileText(first.id, 2, "index.html")).toBe("<h1>Final</h1>")
					expect(yield* fileText(first.id, 2, "app.js")).toBe("run()")

					onTurn(() => undefined)
					const before = keysOf(artifactStore)
					yield* sendAndSettle(apiFetch, session.id, ["Anything else?"], 3)
					expect(yield* json(yield* outputs(session.id))).toEqual(second)
					expect(outputReads).toHaveLength(2)
					expect(keysOf(artifactStore)).toEqual(before)

					onTurn(() => {
						files.delete(`${OUTPUTS}/app.js`)
						files.set(`${OUTPUTS}/copy/index.html`, "<h1>Final</h1>")
					})
					yield* sendAndSettle(apiFetch, session.id, ["Tidy up."], 4)
					const fourth = yield* json<ArtifactBody>(yield* outputs(session.id))
					expect(fourth.version).toBe(3)
					expect(fourth.files.map((file) => file.path)).toEqual(["copy/index.html", "index.html"])
					expect(outputReads).toHaveLength(2)
					expect(manifests()).toBe(3)
					expect(yield* fileText(first.id, 3, "copy/index.html")).toBe("<h1>Final</h1>")

					onTurn(() => {
						files.delete(`${OUTPUTS}/copy/index.html`)
						files.set(`${OUTPUTS}/app.js`, "run()")
					})
					yield* sendAndSettle(apiFetch, session.id, ["Put it back."], 5)
					const fifth = yield* json<ArtifactBody>(yield* outputs(session.id))
					expect([fifth.version, fifth.files]).toEqual([4, second.files])
					expect(outputReads.slice(2)).toEqual([{ sessionId: session.id, paths: ["app.js"] }])
					expect(manifests()).toBe(3)
				}),
		))

	it("answers 404 until something is published, and never publishes a file outside the outputs directory", () =>
		withSessions((apiFetch, { workspaceFiles, artifactStore, onTurn, createSession, outputs }) =>
			Effect.gen(function* () {
				const session = yield* createSession()
				const refusal = (sessionId: string) =>
					Effect.flatMap(outputs(sessionId), (res) =>
						Effect.map(json<{ error: { message: string } }>(res), ({ error }) => [
							res.status,
							error.message,
						]),
					)
				const nothing = [404, `Session ${session.id} has published no outputs.`]
				expect(yield* refusal(session.id)).toEqual(nothing)
				expect(yield* refusal("sess_nope")).toEqual([404, "Session sess_nope not found."])

				const files = workspaceFiles(session.id)
				onTurn(() => {
					files.set("/workspace/notes.md", "private")
					files.set("/mnt/session/scratch.txt", "private")
					files.set("/mnt/session/outputs-old/report.md", "private")
					files.set("/mnt/session/outputs.txt", "private")
					files.set("/outputs/report.md", "private")
				})
				yield* sendAndSettle(apiFetch, session.id, ["Take notes."], 1)
				expect(yield* refusal(session.id)).toEqual(nothing)
				expect(keysOf(artifactStore)).toEqual([])

				onTurn(() => void files.set(`${OUTPUTS}/report.md`, "public"))
				yield* sendAndSettle(apiFetch, session.id, ["Now publish."], 2)
				const artifact = yield* json<ArtifactBody>(yield* outputs(session.id))
				expect(artifact.files).toEqual([fileOf("report.md", "public", "text/markdown")])
				expect(keysOf(artifactStore).filter((key) => key.includes("/blobs/"))).toEqual([
					`artifacts/${SCOPE}/${artifact.id}/blobs/${sha256("public")}`,
				])
			}),
		))

	it("publishes nothing, and still answers, when the outputs are over a limit or hold a path an artifact cannot", () =>
		withSessions(
			(
				apiFetch,
				{
					workspaceFiles,
					outputReads,
					outputListReads,
					outputWalks,
					onTurn,
					warnings,
					createSession,
					outputs,
					replies,
				},
			) =>
				Effect.gen(function* () {
					const session = yield* createSession()
					const files = workspaceFiles(session.id)
					let turn = 0
					const after = (edit: () => void) =>
						Effect.gen(function* () {
							onTurn(edit)
							turn += 1
							outputListReads.length = 0
							yield* sendAndSettle(apiFetch, session.id, ["Go."], turn)
							expect(yield* replies(session.id)).toHaveLength(turn)
							const response = yield* outputs(session.id)
							return [
								response.status === 404 ? 0 : (yield* json<ArtifactBody>(response)).version,
								outputListReads.length,
							]
						})

					expect(
						yield* after(() => {
							for (let index = 0; index <= MAX_ARTIFACT_FILES; index++) {
								files.set(`${OUTPUTS}/part-${index}.txt`, `${index}`)
							}
						}),
					).toEqual([0, 0])
					expect(outputReads).toEqual([])
					expect(outputWalks.at(-1)).toEqual({ limit: WALK_LIMIT, found: 65 })
					expect(warnings).toEqual(["Outputs not published 65 files; the limit is 64."])

					expect(yield* after(() => void files.delete(`${OUTPUTS}/part-0.txt`))).toEqual([1, 64])

					const full = "x".repeat(MAX_ARTIFACT_FILE_BYTES)
					expect(yield* after(() => void files.set(`${OUTPUTS}/part-1.txt`, `${full}x`))).toEqual([
						1, 0,
					])
					expect(warnings.at(-1)).toBe(
						'Outputs not published File "part-1.txt" is 1048577 bytes; the limit is 1048576.',
					)
					expect(yield* after(() => void files.set(`${OUTPUTS}/part-1.txt`, full))).toEqual([2, 64])

					expect(
						yield* after(() => {
							for (let index = 2; index <= MAX_ARTIFACT_FILES; index++) {
								files.set(`${OUTPUTS}/part-${index}.txt`, index <= 4 ? full : "")
							}
						}),
					).toEqual([3, 64])
					expect(outputReads.at(-1)).toEqual({ sessionId: session.id, paths: ["part-10.txt"] })
					expect(yield* after(() => void files.set(`${OUTPUTS}/part-5.txt`, "x"))).toEqual([3, 0])
					expect(warnings.at(-1)).toBe(
						`Outputs not published Files total more than ${MAX_ARTIFACT_TOTAL_BYTES} bytes.`,
					)

					expect(
						yield* after(() => {
							files.set(`${OUTPUTS}/part-5.txt`, "")
							files.delete(`${OUTPUTS}/part-64.txt`)
							files.set(`${OUTPUTS}/back\\slash.txt`, "")
						}),
					).toEqual([3, 0])
					expect(warnings.at(-1)).toBe(
						String.raw`Outputs not published File path "back\\slash.txt" is not allowed.`,
					)

					expect(yield* after(() => void files.delete(`${OUTPUTS}/back\\slash.txt`))).toEqual([
						4, 63,
					])
					expect(warnings).toHaveLength(4)

					expect(yield* after(() => void files.set(`${OUTPUTS}/deep/a/b/c/part.txt`, ""))).toEqual([
						5, 64,
					])
					expect(outputWalks.at(-1)).toEqual({ limit: WALK_LIMIT, found: 68 })

					expect(
						yield* after(() => {
							for (let index = 0; index < 2 * WALK_LIMIT; index++) {
								files.set(`${OUTPUTS}/many/${index}.txt`, "")
							}
						}),
					).toEqual([5, 0])
					expect(outputWalks.at(-1)).toEqual({ limit: WALK_LIMIT, found: WALK_LIMIT })
					expect(warnings.at(-1)).toBe("Outputs not published More than 512 files and directories.")
					expect(warnings).toHaveLength(5)
				}),
		))

	it("leaves the turn successful when storage fails, and publishes when the next turn ends", () =>
		withSessions(
			(apiFetch, { workspaceFiles, artifactStore, onTurn, createSession, outputs, replies }) =>
				Effect.gen(function* () {
					const session = yield* createSession()
					onTurn(() => void workspaceFiles(session.id).set(`${OUTPUTS}/a.txt`, "kept"))
					let puts = 0
					artifactStore.setBeforePut(Effect.sync(() => void (puts += 1)))
					artifactStore.setFailing(true)
					yield* sendAndSettle(apiFetch, session.id, ["Write it."], 1)
					expect(yield* replies(session.id)).toEqual(["ok"])
					expect(keysOf(artifactStore)).toEqual([])
					expect(puts).toBe(ATTEMPTS)
					artifactStore.setFailing(false)
					expect((yield* outputs(session.id)).status).toBe(404)

					onTurn(() => undefined)
					yield* sendAndSettle(apiFetch, session.id, ["Thanks."], 2)
					const artifact = yield* json<ArtifactBody>(yield* outputs(session.id))
					expect(artifact).toMatchObject({
						version: 1,
						files: [fileOf("a.txt", "kept", "text/plain")],
					})

					onTurn(() => void workspaceFiles(session.id).set(`${OUTPUTS}/a.txt`, "changed"))
					artifactStore.setFailing(true)
					yield* sendAndSettle(apiFetch, session.id, ["Change it."], 3)
					expect(yield* replies(session.id)).toEqual(["ok", "ok", "ok"])
					artifactStore.setFailing(false)
					expect((yield* json<ArtifactBody>(yield* outputs(session.id))).version).toBe(1)
					onTurn(() => undefined)
					yield* sendAndSettle(apiFetch, session.id, ["Thanks."], 4)
					expect(yield* json<ArtifactBody>(yield* outputs(session.id))).toMatchObject({
						version: 2,
						files: [fileOf("a.txt", "changed", "text/plain")],
					})
				}),
		))

	it("publishes a file only as it was listed, listing again when one has changed", () =>
		withSessions(
			(
				apiFetch,
				{ workspaceFiles, artifactStore, setBeforeOutputsRead, onTurn, createSession, outputs },
			) =>
				Effect.gen(function* () {
					const session = yield* createSession()
					const files = workspaceFiles(session.id)
					const blobs = () =>
						keysOf(artifactStore)
							.filter((key) => key.includes("/blobs/"))
							.map((key) => key.slice(key.lastIndexOf("/") + 1))
					onTurn(() => {
						files.set(`${OUTPUTS}/a.txt`, "listed")
						files.set(`${OUTPUTS}/b.txt`, "steady")
					})

					let edits = 0
					setBeforeOutputsRead(() => void files.set(`${OUTPUTS}/a.txt`, `edit ${++edits}`))
					yield* sendAndSettle(apiFetch, session.id, ["Write it."], 1)
					expect((yield* outputs(session.id)).status).toBe(404)
					expect(keysOf(artifactStore)).toEqual([])
					expect(edits).toBe(ATTEMPTS)

					setBeforeOutputsRead(() => void files.set(`${OUTPUTS}/a.txt`, "edited"))
					onTurn(() => undefined)
					yield* sendAndSettle(apiFetch, session.id, ["Again."], 2)
					const published = yield* json<ArtifactBody>(yield* outputs(session.id))
					expect(published).toMatchObject({
						version: 1,
						files: [
							fileOf("a.txt", "edited", "text/plain"),
							fileOf("b.txt", "steady", "text/plain"),
						],
					})
					expect(blobs()).toEqual([sha256("edited"), sha256("steady")].toSorted())

					onTurn(() => void files.set(`${OUTPUTS}/c.txt`, "fleeting"))
					setBeforeOutputsRead(() => void files.delete(`${OUTPUTS}/c.txt`))
					yield* sendAndSettle(apiFetch, session.id, ["Again."], 3)
					expect(yield* json(yield* outputs(session.id))).toEqual(published)
					expect(blobs()).toHaveLength(2)
				}),
		))

	it("keeps the last complete version when a listed file cannot be read", () =>
		withSessions(
			(apiFetch, { workspaceFiles, failingOutputReads, onTurn, createSession, outputs }) =>
				Effect.gen(function* () {
					const session = yield* createSession()
					const files = workspaceFiles(session.id)
					onTurn(() => {
						files.set(`${OUTPUTS}/a.txt`, "one")
						files.set(`${OUTPUTS}/b.txt`, "two")
					})
					yield* sendAndSettle(apiFetch, session.id, ["Write it."], 1)
					const published = yield* json<ArtifactBody>(yield* outputs(session.id))

					onTurn(() => void files.set(`${OUTPUTS}/a.txt`, "changed"))
					failingOutputReads.add(`${OUTPUTS}/b.txt`)
					yield* sendAndSettle(apiFetch, session.id, ["Change it."], 2)
					expect(yield* json(yield* outputs(session.id))).toEqual(published)

					failingOutputReads.clear()
					onTurn(() => undefined)
					yield* sendAndSettle(apiFetch, session.id, ["Again."], 3)
					expect(yield* json<ArtifactBody>(yield* outputs(session.id))).toMatchObject({
						version: 2,
						files: [fileOf("a.txt", "changed", "text/plain"), fileOf("b.txt", "two", "text/plain")],
					})
				}),
		))

	it("publishes in the same turn when the store fails once", () =>
		withSessions(
			(
				apiFetch,
				{ workspaceFiles, artifactStore, onTurn, warnings, createSession, outputs, replies },
			) =>
				Effect.gen(function* () {
					const session = yield* createSession()
					onTurn(() => void workspaceFiles(session.id).set(`${OUTPUTS}/a.txt`, "kept"))
					let puts = 0
					artifactStore.setBeforePut(
						Effect.sync(() => {
							puts += 1
							artifactStore.setFailing(puts === 1)
						}),
					)
					yield* sendAndSettle(apiFetch, session.id, ["Write it."], 1)
					expect(yield* replies(session.id)).toEqual(["ok"])
					expect(yield* json<ArtifactBody>(yield* outputs(session.id))).toMatchObject({
						version: 1,
						files: [fileOf("a.txt", "kept", "text/plain")],
					})
					expect(puts).toBe(2)
					expect(warnings).toEqual([])
				}),
		))

	it("builds on a version added while it was publishing, and loses none", () =>
		withSessions(
			(apiFetch, { workspaceFiles, artifactStore, onTurn, createSession, outputs, replies }) =>
				Effect.gen(function* () {
					const session = yield* createSession()
					const files = workspaceFiles(session.id)
					onTurn(() => void files.set(`${OUTPUTS}/a.txt`, "one"))
					yield* sendAndSettle(apiFetch, session.id, ["Write it."], 1)
					const artifact = yield* json<ArtifactBody>(yield* outputs(session.id))
					const versionFiles = (version: number) =>
						Effect.flatMap(
							request(apiFetch, "GET", `/v1/artifacts/${artifact.id}/versions/${version}`),
							(res) =>
								Effect.map(json<{ files?: ReadonlyArray<FileBody> }>(res), ({ files: listed }) => [
									res.status,
									listed,
								]),
						)

					artifactStore.setBeforePut(
						Effect.suspend(() => {
							artifactStore.setBeforePut(Effect.void)
							return Effect.asVoid(
								request(apiFetch, "POST", `/v1/artifacts/${artifact.id}/versions`, {
									version: 1,
									files: [{ path: "theirs.txt", content: "theirs" }],
								}),
							)
						}),
					)
					onTurn(() => void files.set(`${OUTPUTS}/a.txt`, "two"))
					yield* sendAndSettle(apiFetch, session.id, ["Change it."], 2)
					expect(yield* replies(session.id)).toEqual(["ok", "ok"])
					expect(yield* json<ArtifactBody>(yield* outputs(session.id))).toMatchObject({
						version: 3,
						files: [fileOf("a.txt", "two", "text/plain")],
					})
					expect(yield* versionFiles(1)).toEqual([200, [fileOf("a.txt", "one", "text/plain")]])
					expect(yield* versionFiles(2)).toEqual([
						200,
						[fileOf("theirs.txt", "theirs", "text/plain")],
					])
					expect(yield* versionFiles(3)).toEqual([200, [fileOf("a.txt", "two", "text/plain")]])
					expect((yield* versionFiles(4))[0]).toBe(404)

					onTurn(() => undefined)
					yield* sendAndSettle(apiFetch, session.id, ["Thanks."], 3)
					expect((yield* json<ArtifactBody>(yield* outputs(session.id))).version).toBe(3)
				}),
		))

	it("publishes the directory as it stands: what a failed turn left is published by the next turn that replies, even one that wrote nothing", () =>
		withSessions((apiFetch, { workspaceFiles, onTurn, createSession, outputs, replies }) =>
			Effect.gen(function* () {
				const session = yield* createSession()
				onTurn(() => {
					workspaceFiles(session.id).set(`${OUTPUTS}/index.html`, "<h1>Draft</h1>")
					throw new Error("provider down")
				})
				yield* sendAndSettle(apiFetch, session.id, ["Build the page."], 1)
				expect(yield* replies(session.id)).toEqual([])
				expect((yield* outputs(session.id)).status).toBe(404)

				onTurn(() => undefined)
				yield* sendAndSettle(apiFetch, session.id, ["What is the weather?"], 2)
				expect(yield* replies(session.id)).toEqual(["ok"])
				expect(yield* json<ArtifactBody>(yield* outputs(session.id))).toMatchObject({
					version: 1,
					files: [fileOf("index.html", "<h1>Draft</h1>", "text/html")],
				})
			}),
		))

	it("stops publishing once the session's artifact is deleted, and leaves nothing in storage", () =>
		withSessions((apiFetch, { workspaceFiles, artifactStore, onTurn, createSession, outputs }) =>
			Effect.gen(function* () {
				const racing = yield* createSession()
				const files = workspaceFiles(racing.id)
				onTurn(() => void files.set(`${OUTPUTS}/a.txt`, "one"))
				yield* sendAndSettle(apiFetch, racing.id, ["Write it."], 1)
				const artifact = yield* json<ArtifactBody>(yield* outputs(racing.id))

				artifactStore.setBeforePut(
					Effect.asVoid(request(apiFetch, "DELETE", `/v1/artifacts/${artifact.id}`)).pipe(
						Effect.andThen(Effect.sync(() => artifactStore.setBeforePut(Effect.void))),
					),
				)
				onTurn(() => void files.set(`${OUTPUTS}/a.txt`, "two"))
				yield* sendAndSettle(apiFetch, racing.id, ["Change it."], 2)
				expect((yield* outputs(racing.id)).status).toBe(404)
				expect(keysOf(artifactStore)).toEqual([])

				onTurn(() => void files.set(`${OUTPUTS}/a.txt`, "three"))
				yield* sendAndSettle(apiFetch, racing.id, ["Change it again."], 3)
				expect((yield* outputs(racing.id)).status).toBe(404)
				expect(keysOf(artifactStore)).toEqual([])
			}),
		))

	it("publishes when a turn that already ran is settled again", () =>
		withSessions(
			(
				apiFetch,
				{ workspaceFiles, artifactStore, requests, harness, onTurn, createSession, outputs },
			) =>
				Effect.gen(function* () {
					const session = yield* createSession()
					onTurn(() => void workspaceFiles(session.id).set(`${OUTPUTS}/a.txt`, "kept"))
					artifactStore.setFailing(true)
					yield* sendAndSettle(apiFetch, session.id, ["Write it."], 1)
					artifactStore.setFailing(false)
					expect((yield* outputs(session.id)).status).toBe(404)
					expect(requests).toHaveLength(1)

					const settleAgain = harness.runTurn({
						session_id: SessionId.make(session.id),
						agent_id: session.agent.id,
						agent_version: session.agent.version,
						environment_id: session.environment_id,
						turn: 1,
						input: ["Write it."],
					})
					expect((yield* Effect.orDie(settleAgain)).text).toBe("ok")
					expect((yield* json<ArtifactBody>(yield* outputs(session.id))).version).toBe(1)
					expect((yield* Effect.orDie(settleAgain)).text).toBe("ok")
					expect((yield* json<ArtifactBody>(yield* outputs(session.id))).version).toBe(1)

					workspaceFiles(session.id).set(`${OUTPUTS}/a.txt`, "late")
					yield* Effect.orDie(settleAgain)
					expect(yield* json<ArtifactBody>(yield* outputs(session.id))).toMatchObject({
						version: 2,
						files: [fileOf("a.txt", "late", "text/plain")],
					})

					workspaceFiles(session.id).set(`${OUTPUTS}/a.txt`, "kept")
					yield* Effect.orDie(settleAgain)
					expect(yield* json<ArtifactBody>(yield* outputs(session.id))).toMatchObject({
						version: 3,
						files: [fileOf("a.txt", "kept", "text/plain")],
					})
					expect(requests).toHaveLength(1)
				}),
		))

	it("reads the outputs at the version the artifact has committed, without reading a projection", () =>
		withSessions((apiFetch, { workspaceFiles, onTurn, createSession, viewlessOutputs }) =>
			Effect.gen(function* () {
				const session = yield* createSession()
				const files = workspaceFiles(session.id)
				onTurn(() => void files.set(`${OUTPUTS}/a.txt`, "one"))
				yield* sendAndSettle(apiFetch, session.id, ["Write it."], 1)
				expect((yield* json<ArtifactBody>(yield* viewlessOutputs(session.id))).version).toBe(1)

				onTurn(() => void files.set(`${OUTPUTS}/a.txt`, "two"))
				yield* sendAndSettle(apiFetch, session.id, ["Change it."], 2)
				const head = yield* json<ArtifactBody>(yield* viewlessOutputs(session.id))
				expect([head.version, head.files]).toEqual([2, [fileOf("a.txt", "two", "text/plain")]])
			}),
		))

	it("holds outputs to the rules an upload is held to, and refuses a path that is also a folder as an upload does", () =>
		withSessions(
			(apiFetch, { workspaceFiles, onTurn, warnings, createSession, outputs, upload, replies }) =>
				Effect.gen(function* () {
					const session = yield* createSession()
					const files = workspaceFiles(session.id)
					const conflict =
						'File path "docs" is also a folder of "docs/index.md"; a path cannot be both.'
					onTurn(() => {
						files.set(`${OUTPUTS}/docs`, "a file")
						files.set(`${OUTPUTS}/docs/index.md`, "# Docs")
					})
					yield* sendAndSettle(apiFetch, session.id, ["Write the docs."], 1)
					expect(yield* replies(session.id)).toEqual(["ok"])
					expect((yield* outputs(session.id)).status).toBe(404)
					expect(warnings).toEqual([`Outputs not published ${conflict}`])

					const uploaded = yield* upload([
						{ path: "docs", content: "a file" },
						{ path: "docs/index.md", content: "# Docs" },
					])
					expect(uploaded.status).toBe(400)
					expect((yield* json<{ error: { message: string } }>(uploaded)).error.message).toBe(
						conflict,
					)

					onTurn(() => {
						files.delete(`${OUTPUTS}/docs`)
						files.set(`${OUTPUTS}/html`, "<p>")
					})
					yield* sendAndSettle(apiFetch, session.id, ["Fix it."], 2)
					const published = yield* json<ArtifactBody>(yield* outputs(session.id))
					const byHand = yield* json<ArtifactBody>(
						yield* upload([
							{ path: "docs/index.md", content: "# Docs" },
							{ path: "html", content: "<p>" },
						]),
					)
					expect(published.files).toEqual([
						fileOf("docs/index.md", "# Docs", "text/markdown"),
						fileOf("html", "<p>", "application/octet-stream"),
					])
					expect(published.files).toEqual(byHand.files)
					expect(warnings).toHaveLength(1)
				}),
		))

	it("keeps the last version when a turn empties the outputs directory", () =>
		withSessions(
			(apiFetch, { workspaceFiles, artifactStore, onTurn, warnings, createSession, outputs }) =>
				Effect.gen(function* () {
					const session = yield* createSession()
					const files = workspaceFiles(session.id)
					onTurn(() => void files.set(`${OUTPUTS}/a.txt`, "kept"))
					yield* sendAndSettle(apiFetch, session.id, ["Write it."], 1)
					const first = yield* json<ArtifactBody>(yield* outputs(session.id))
					const stored = keysOf(artifactStore)

					onTurn(() => void files.delete(`${OUTPUTS}/a.txt`))
					yield* sendAndSettle(apiFetch, session.id, ["Clear it."], 2)
					expect(yield* json(yield* outputs(session.id))).toEqual(first)
					expect(first).toMatchObject({
						version: 1,
						files: [fileOf("a.txt", "kept", "text/plain")],
					})
					expect(keysOf(artifactStore)).toEqual(stored)
					expect(warnings).toEqual([])
				}),
		))

	it("publishes nothing for a turn that failed or was interrupted, and everything once a turn succeeds", () =>
		withSessions(
			(
				apiFetch,
				{
					workspaceFiles,
					artifactStore,
					outputListReads,
					requests,
					harness,
					onTurn,
					createSession,
					outputs,
					replies,
				},
			) =>
				Effect.gen(function* () {
					const session = yield* createSession()
					const files = workspaceFiles(session.id)
					const eventTypes = Effect.map(
						Effect.flatMap(
							request(apiFetch, "GET", `/v1/sessions/${session.id}/events?limit=100`),
							(res) =>
								json<{
									data: ReadonlyArray<{ type: string; stop_reason?: { type: string } }>
								}>(res),
						),
						({ data }) => data.map((event) => event.stop_reason?.type ?? event.type),
					)
					const unpublished = Effect.gen(function* () {
						expect((yield* outputs(session.id)).status).toBe(404)
						expect(keysOf(artifactStore)).toEqual([])
						expect(outputListReads).toEqual([])
					})

					onTurn(() => {
						files.set(`${OUTPUTS}/index.html`, "<script src=app.js></script>")
						throw new Error("provider down")
					})
					yield* sendAndSettle(apiFetch, session.id, ["Build the page."], 1)
					expect(yield* eventTypes).toContain("session.error")
					expect(yield* replies(session.id)).toEqual([])
					yield* unpublished

					const modelCalls = requests.length
					const settledAgain = yield* Effect.exit(
						harness.runTurn({
							session_id: SessionId.make(session.id),
							agent_id: session.agent.id,
							agent_version: session.agent.version,
							environment_id: session.environment_id,
							turn: 1,
							input: ["Build the page."],
						}),
					)
					expect(settledAgain._tag).toBe("Failure")
					expect(requests).toHaveLength(modelCalls)
					yield* unpublished

					let started: () => void = () => undefined
					const running = new Promise<void>((resolve) => {
						started = resolve
					})
					onTurn((signal) => {
						files.set(`${OUTPUTS}/app.js`, "run(")
						started()
						return new Promise((resolve) => {
							signal?.addEventListener("abort", () => resolve("aborted"), { once: true })
						})
					})
					const send = (events: ReadonlyArray<unknown>) =>
						request(apiFetch, "POST", `/v1/sessions/${session.id}/events`, { events })
					yield* send([{ type: "user.message", content: [{ type: "text", text: "Go on." }] }])
					yield* Effect.promise(() => running)
					expect((yield* send([{ type: "user.interrupt" }])).status).toBe(200)
					yield* waitForSession(apiFetch, session.id, (s) => s.status === "idle" && s.turn === 2)
					expect(yield* eventTypes).toContain("interrupted")
					yield* unpublished

					onTurn(() => void files.set(`${OUTPUTS}/app.js`, "run()"))
					yield* sendAndSettle(apiFetch, session.id, ["Finish it."], 3)
					expect(yield* replies(session.id)).toEqual(["ok"])
					expect(yield* json<ArtifactBody>(yield* outputs(session.id))).toMatchObject({
						version: 1,
						files: [
							fileOf("app.js", "run()", "text/javascript"),
							fileOf("index.html", "<script src=app.js></script>", "text/html"),
						],
					})
				}),
		))

	it(
		"cuts off publishing that stalls, so the turn still answers, and publishes when the next turn ends",
		() =>
			withSessions(
				(
					apiFetch,
					{ workspaceFiles, artifactStore, onTurn, warnings, createSession, outputs, replies },
				) =>
					Effect.gen(function* () {
						const session = yield* createSession()
						onTurn(() => void workspaceFiles(session.id).set(`${OUTPUTS}/a.txt`, "kept"))
						artifactStore.setBeforePut(Effect.never)
						yield* sendAndSettle(apiFetch, session.id, ["Write it."], 1)
						expect(yield* replies(session.id)).toEqual(["ok"])
						expect(warnings).toEqual(["Outputs not published in time"])
						expect((yield* outputs(session.id)).status).toBe(404)

						let reached = 0
						artifactStore.setBeforePut(
							Effect.andThen(
								Effect.sync(() => void (reached += 1)),
								Effect.sleep(STALLED_PUT),
							),
						)
						onTurn(() => undefined)
						yield* sendAndSettle(apiFetch, session.id, ["Thanks."], 2)
						expect(yield* replies(session.id)).toEqual(["ok", "ok"])
						expect(warnings).toHaveLength(2)
						yield* Effect.sleep(STALLED_PUT)
						yield* Effect.sleep(PUBLISH_CUT_OFF)
						expect(reached).toBe(1)
						expect(keysOf(artifactStore)).toEqual([])
						expect((yield* outputs(session.id)).status).toBe(404)

						artifactStore.setBeforePut(Effect.void)
						yield* sendAndSettle(apiFetch, session.id, ["Thanks again."], 3)
						expect(yield* json<ArtifactBody>(yield* outputs(session.id))).toMatchObject({
							version: 1,
							files: [fileOf("a.txt", "kept", "text/plain")],
						})
						expect(warnings).toHaveLength(2)
					}),
				PUBLISH_CUT_OFF,
			),
		20_000,
	)

	it("ends publishing by the turn's settle deadline, however long a publish may otherwise take", () =>
		withSessions(
			(
				apiFetch,
				{ workspaceFiles, artifactStore, onTurn, warnings, createSession, outputs, replies },
			) =>
				Effect.gen(function* () {
					const session = yield* createSession()
					onTurn(() => void workspaceFiles(session.id).set(`${OUTPUTS}/a.txt`, "kept"))
					artifactStore.setBeforePut(Effect.never)
					yield* sendAndSettle(apiFetch, session.id, ["Write it."], 1)
					expect(yield* replies(session.id)).toEqual(["ok"])
					expect(warnings).toEqual(["Outputs not published in time"])
					expect((yield* outputs(session.id)).status).toBe(404)
				}),
			"1 hour",
			SETTLE_DEADLINE,
		))
})
