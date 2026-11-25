import { describe, expect, it } from "vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Base64 from "effect/encoding/Base64"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import {
	buildArtifactVersion,
	MAX_ARTIFACT_BODY_BYTES,
	MAX_ARTIFACT_FILE_BYTES,
	MAX_ARTIFACT_FILES,
	MAX_ARTIFACT_TOTAL_BYTES,
} from "../src/Artifacts/ArtifactFiles.ts"
import { Artifact } from "@checkfu/domain/Artifact/Artifact.aggregate"
import { ArtifactVersionView } from "@checkfu/domain/Artifact/ArtifactVersionView.view"
import { ExpireArtifactReservation } from "@checkfu/domain/Artifact/ExpireArtifactReservation.command"
import { ArtifactId } from "@checkfu/domain/Artifact/Artifact.id"
import * as Digest from "effect/crypto/Digest"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import type { ArtifactFileInput, BuiltArtifactVersion } from "../src/Artifacts/ArtifactFiles.ts"
import {
	ArtifactStore,
	artifactBlobKey,
	artifactPrefix,
	deleteUntilEmpty,
} from "../src/Artifacts/ArtifactStore.ts"
import type { ArtifactStoreService } from "../src/Artifacts/ArtifactStore.ts"
import { ARTIFACT_BODY_TOO_LARGE_MESSAGE, MAX_REQUEST_BODY_BYTES } from "../src/Http/HttpHelpers.ts"
import { keyedArtifactId } from "../src/Http/ArtifactsHandlers.ts"
import { makeApiHandler } from "../src/Http/Router.ts"
import { DEFAULT_STORAGE_SCOPE } from "../src/Placement.ts"
import {
	AUTH_HEADERS,
	makeAssistantReply,
	makePiDurableTestLayer,
	sendRequest,
} from "./helpers/ApiHarness.ts"

interface FileEntry {
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
	readonly files: ReadonlyArray<FileEntry>
	readonly created_at: string
	readonly updated_at: string
}

interface VersionBody {
	readonly type: string
	readonly artifact_id: string
	readonly version: number
	readonly file_count: number
	readonly total_bytes: number
	readonly files: ReadonlyArray<FileEntry>
}

interface FileBody {
	readonly type: string
	readonly path: string
	readonly size: number
	readonly content_type: string
	readonly encoding: string
	readonly content: string
}

interface ErrorBody {
	readonly error: { readonly type: string; readonly message: string }
}

interface Gate {
	readonly reached: Effect.Effect<void>
	readonly release: Effect.Effect<boolean>
}

const SCOPE = DEFAULT_STORAGE_SCOPE

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe])

const withApi = <A>(
	run: (api: {
		readonly call: (
			method: string,
			path: string,
			body?: unknown,
			headers?: Record<string, string>,
		) => Effect.Effect<Response>
		readonly store: ReturnType<typeof makePiDurableTestLayer>["artifactStore"]
		readonly statusForKey: (idempotencyKey: string) => Effect.Effect<string>
		readonly postRaw: (path: string, body: string) => Effect.Effect<Response>
		readonly callLagging: (path: string) => Effect.Effect<Response>
		readonly steerReads: (read: (call: number) => "real" | "die" | "stale") => void
		readonly callSteered: (method: string, path: string, body?: unknown) => Effect.Effect<Response>
		readonly callViewless: (
			method: string,
			path: string,
			body?: unknown,
			headers?: Record<string, string>,
		) => Effect.Effect<Response>
		readonly viewReads: () => number
		readonly callInterleaved: (method: string, path: string) => Effect.Effect<Response>
		readonly afterNextRead: (effect: Effect.Effect<void>) => void
		readonly callLostReply: (path: string, body: unknown) => Effect.Effect<Response>
		readonly steerSends: (mode: (command: string) => "real" | "lost" | "landed") => void
		readonly sentCommandIds: ReadonlyArray<string | undefined>
		readonly callSteeredSend: (
			path: string,
			body: unknown,
			headers?: Record<string, string>,
		) => Effect.Effect<Response>
		readonly holdSend: (command: string) => Effect.Effect<Gate>
		readonly deleteSteeredSend: (path: string) => Effect.Effect<Response>
		readonly reservationsOf: (
			artifactId: string,
		) => Effect.Effect<{ readonly made: number; readonly open: number }>
		readonly expire: (artifactId: string, reservation: number) => Effect.Effect<void>
		readonly service: ArtifactStoreService
		readonly serviceIn: (scope: string) => Effect.Effect<ArtifactStoreService>
		readonly build: (files: ReadonlyArray<ArtifactFileInput>) => Effect.Effect<BuiltArtifactVersion>
	}) => Effect.Effect<A>,
) => {
	const { layer, closeAll, artifactStore } = makePiDurableTestLayer(async (model) =>
		makeAssistantReply(model, null, "unused", 1, 1),
	)
	return Effect.runPromise(
		Effect.gen(function* () {
			const { fetch: apiFetch } = yield* makeApiHandler
			const artifacts = yield* Artifact
			const digest = yield* Digest.Digest
			const versionViews = yield* ArtifactVersionView
			const lagging = yield* makeApiHandler.pipe(
				Effect.provideService(ArtifactVersionView, {
					...versionViews,
					get: () => Effect.succeedNone,
				}),
			)
			let viewReads = 0
			const touched = () =>
				Effect.suspend(() => {
					viewReads += 1
					return Effect.die(new Error("a head read touched a view"))
				})
			const viewless = yield* makeApiHandler.pipe(
				Effect.provideService(ArtifactVersionView, {
					...versionViews,
					get: touched,
					snapshot: touched,
					waitFor: touched,
					list: touched,
				}),
			)
			const aggregates = yield* Artifact
			let afterRead: Effect.Effect<void> = Effect.void
			const interleaved = yield* makeApiHandler.pipe(
				Effect.provideService(Artifact, {
					...aggregates,
					get: (ref) =>
						Effect.tap(aggregates.get(ref), () => {
							const run = afterRead
							afterRead = Effect.void
							return run
						}),
				}),
			)
			const lostReply = yield* makeApiHandler.pipe(
				Effect.provideService(Artifact, {
					...aggregates,
					send: (command, options) =>
						Effect.andThen(
							aggregates.send(command, options),
							Effect.die(new Error("reply was lost")),
						),
				}),
			)
			let sendMode: (command: string) => "real" | "lost" | "landed" = () => "real"
			let beforeSend: (command: string) => Effect.Effect<void> = () => Effect.void
			const sentCommandIds: Array<string | undefined> = []
			const steeredSend = yield* makeApiHandler.pipe(
				Effect.provideService(Artifact, {
					...aggregates,
					send: (command, options) =>
						Effect.andThen(
							Effect.suspend(() => beforeSend(command._tag)),
							Effect.suspend(() => {
								sentCommandIds.push(options?.commandId)
								const mode = sendMode(command._tag)
								return mode === "lost"
									? Effect.die(new Error("command was lost"))
									: mode === "landed"
										? Effect.andThen(
												aggregates.send(command, options),
												Effect.die(new Error("reply was lost")),
											)
										: aggregates.send(command, options)
							}),
						),
				}),
			)
			const service = yield* ArtifactStore
			const serviceIn = (scope: string) =>
				Effect.provide(Effect.service(ArtifactStore), artifactStore.layerIn(scope))
			let steer: (call: number) => "real" | "die" | "stale" = () => "real"
			const reads = new Map<string, number>()
			const firstSeen = new Map<string, Effect.Success<ReturnType<typeof aggregates.get>>>()
			const steered = yield* makeApiHandler.pipe(
				Effect.provideService(Artifact, {
					...aggregates,
					get: (ref) =>
						Effect.gen(function* () {
							const key = String(ref)
							const call = (reads.get(key) ?? 0) + 1
							reads.set(key, call)
							const mode = steer(call)
							if (mode === "die") {
								return yield* Effect.die(new Error("aggregate read failed"))
							}
							const earlier = firstSeen.get(key)
							if (mode === "stale" && earlier !== undefined) {
								return earlier
							}
							const state = yield* aggregates.get(ref)
							if (!firstSeen.has(key)) {
								firstSeen.set(key, state)
							}
							return state
						}),
				}),
			)
			return yield* run({
				service,
				build: (files) => Effect.orDie(buildArtifactVersion(digest, files)),
				steerSends: (mode) => {
					sendMode = mode
				},
				sentCommandIds,
				deleteSteeredSend: (path) =>
					sendRequest(steeredSend.fetch, { method: "DELETE", path, headers: AUTH_HEADERS }),
				callSteeredSend: (path, body, headers) =>
					sendRequest(steeredSend.fetch, {
						method: "POST",
						path,
						headers: { ...AUTH_HEADERS, ...headers },
						body,
					}),
				holdSend: (command) =>
					Effect.gen(function* () {
						const reached = yield* Deferred.make<void>()
						const released = yield* Deferred.make<void>()
						beforeSend = (sent) =>
							sent === command
								? Effect.gen(function* () {
										beforeSend = () => Effect.void
										yield* Deferred.succeed(reached, undefined)
										yield* Deferred.await(released)
									})
								: Effect.void
						return {
							reached: Deferred.await(reached),
							release: Deferred.succeed(released, undefined),
						}
					}),
				reservationsOf: (artifactId) =>
					Effect.map(Effect.orDie(artifacts.get(ArtifactId.make(artifactId))), (state) => ({
						made: state.reservations,
						open: state.open_reservation,
					})),
				expire: (artifactId, reservation) =>
					Effect.orDie(
						artifacts.send(
							new ExpireArtifactReservation({
								artifact_id: ArtifactId.make(artifactId),
								reservation,
							}),
						),
					),
				serviceIn,
				callLostReply: (path, body) =>
					sendRequest(lostReply.fetch, { method: "POST", path, headers: AUTH_HEADERS, body }),
				steerReads: (read) => {
					steer = read
					reads.clear()
				},
				callSteered: (method, path, body) =>
					sendRequest(steered.fetch, {
						method,
						path,
						headers: AUTH_HEADERS,
						...(body === undefined ? {} : { body }),
					}),
				callViewless: (method, path, body, headers) =>
					sendRequest(viewless.fetch, {
						method,
						path,
						headers: { ...AUTH_HEADERS, ...headers },
						...(body === undefined ? {} : { body }),
					}),
				viewReads: () => viewReads,
				callInterleaved: (method, path) =>
					sendRequest(interleaved.fetch, { method, path, headers: AUTH_HEADERS }),
				afterNextRead: (effect) => {
					afterRead = effect
				},
				callLagging: (path) =>
					sendRequest(lagging.fetch, { method: "GET", path, headers: AUTH_HEADERS }),
				postRaw: (path, body) =>
					Effect.map(
						apiFetch.pipe(
							Effect.provideService(
								HttpServerRequest.HttpServerRequest,
								HttpServerRequest.fromWeb(
									new Request(`http://localhost${path}`, {
										method: "POST",
										headers: { ...AUTH_HEADERS, "content-type": "application/json" },
										body,
									}),
								),
							),
						),
						HttpServerResponse.toWeb,
					),
				statusForKey: (idempotencyKey) =>
					Effect.gen(function* () {
						const id = yield* keyedArtifactId(digest, idempotencyKey)
						return (yield* artifacts.get(id)).status
					}).pipe(Effect.orDie),
				call: (method, path, body, headers) =>
					sendRequest(apiFetch, {
						method,
						path,
						headers: { ...AUTH_HEADERS, ...headers },
						...(body === undefined ? {} : { body }),
					}),
				store: artifactStore,
			})
		}).pipe(Effect.scoped, Effect.provide(layer), Effect.ensuring(Effect.promise(closeAll))),
	)
}

const json = <T>(response: Response) => Effect.promise(() => response.json() as Promise<T>)

const artifactIdsIn = (store: { readonly objects: ReadonlyMap<string, unknown> }) => [
	...new Set(
		[...store.objects.keys()].flatMap((key) => {
			const [root, scope, id] = key.split("/")
			return root === "artifacts" && scope === SCOPE && id !== undefined ? [id] : []
		}),
	),
]

const eventually = (check: Effect.Effect<boolean>, what: string) =>
	Effect.gen(function* () {
		for (let attempt = 0; attempt < 300; attempt++) {
			if (yield* check) {
				return
			}
			yield* Effect.sleep("10 millis")
		}
		return yield* Effect.die(new Error(`timed out waiting until ${what}`))
	})

describe("Artifacts API", () => {
	it("infers a content type from the file name, wherever the file sits", () =>
		withApi(({ call }) =>
			Effect.gen(function* () {
				const created = yield* call("POST", "/v1/artifacts", {
					name: "Types",
					files: ["html", "dir/html", "index.html", "a/b.css"].map((path) => ({
						path,
						content: "x",
					})),
				})
				expect(created.status).toBe(201)
				const artifact = yield* json<ArtifactBody>(created)
				expect(artifact.files.map((file) => [file.path, file.content_type])).toEqual([
					["a/b.css", "text/css"],
					["dir/html", "application/octet-stream"],
					["html", "application/octet-stream"],
					["index.html", "text/html"],
				])
			}),
		))

	it("creates an artifact, adds a version, and reads files of each version back", () =>
		withApi(({ call }) =>
			Effect.gen(function* () {
				const created = yield* call("POST", "/v1/artifacts", {
					name: "Report",
					files: [
						{ path: "index.html", content: "<h1>v1</h1>" },
						{ path: "assets/logo.png", content: Base64.encode(PNG_BYTES), encoding: "base64" },
					],
				})
				expect(created.status).toBe(201)
				const artifact = yield* json<ArtifactBody>(created)
				expect(artifact).toMatchObject({
					type: "artifact",
					name: "Report",
					version: 1,
					file_count: 2,
					total_bytes: 11 + PNG_BYTES.byteLength,
				})
				expect(artifact.id).toMatch(/^art_[0-9a-f]{24}$/u)
				expect(artifact.files.map((file) => [file.path, file.content_type, file.size])).toEqual([
					["assets/logo.png", "image/png", PNG_BYTES.byteLength],
					["index.html", "text/html", 11],
				])

				const added = yield* call("POST", `/v1/artifacts/${artifact.id}/versions`, {
					version: 1,
					files: [{ path: "index.html", content: "<h1>v2</h1>", content_type: "text/plain" }],
				})
				expect(added.status).toBe(201)
				expect(yield* json<VersionBody>(added)).toMatchObject({
					type: "artifact_version",
					artifact_id: artifact.id,
					version: 2,
					file_count: 1,
					total_bytes: 11,
					files: [{ path: "index.html", content_type: "text/plain", size: 11 }],
				})

				const head = yield* json<ArtifactBody>(yield* call("GET", `/v1/artifacts/${artifact.id}`))
				expect(head).toMatchObject({ version: 2, file_count: 1, created_at: artifact.created_at })
				expect(head.files.map((file) => file.path)).toEqual(["index.html"])

				const first = yield* json<VersionBody>(
					yield* call("GET", `/v1/artifacts/${artifact.id}/versions/1`),
				)
				expect(first.files).toEqual(artifact.files)

				const text = yield* json<FileBody>(
					yield* call("GET", `/v1/artifacts/${artifact.id}/versions/1/file?file=index.html`),
				)
				expect(text).toMatchObject({
					type: "artifact_file",
					encoding: "utf8",
					content: "<h1>v1</h1>",
					content_type: "text/html",
				})
				const binary = yield* json<FileBody>(
					yield* call(
						"GET",
						`/v1/artifacts/${artifact.id}/versions/1/file?file=${encodeURIComponent("assets/logo.png")}`,
					),
				)
				expect(binary.encoding).toBe("base64")
				expect(binary.content).toBe(Base64.encode(PNG_BYTES))
				const second = yield* json<FileBody>(
					yield* call("GET", `/v1/artifacts/${artifact.id}/versions/2/file?file=index.html`),
				)
				expect(second.content).toBe("<h1>v2</h1>")
			}),
		))

	it("answers 404 for a missing artifact, version, and file, and 409 for a stale version", () =>
		withApi(({ call }) =>
			Effect.gen(function* () {
				const files = [{ path: "a.txt", content: "a" }]
				expect((yield* call("GET", "/v1/artifacts/art_missing")).status).toBe(404)
				expect(
					(yield* call("POST", "/v1/artifacts/art_missing/versions", { version: 1, files })).status,
				).toBe(404)
				expect((yield* call("DELETE", "/v1/artifacts/art_missing")).status).toBe(404)

				const artifact = yield* json<ArtifactBody>(
					yield* call("POST", "/v1/artifacts", { name: "A", files }),
				)
				expect((yield* call("GET", `/v1/artifacts/${artifact.id}/versions/2`)).status).toBe(404)
				expect((yield* call("GET", `/v1/artifacts/${artifact.id}/versions/0`)).status).toBe(400)
				expect(
					(yield* call("GET", `/v1/artifacts/${artifact.id}/versions/1/file?file=b.txt`)).status,
				).toBe(404)
				const stale = yield* call("POST", `/v1/artifacts/${artifact.id}/versions`, {
					version: 2,
					files,
				})
				expect(stale.status).toBe(409)
				expect((yield* json<ErrorBody>(stale)).error.type).toBe("conflict_error")
				const invalid = [{ path: "a.bin", content: "***", encoding: "base64" }]
				expect(
					(yield* call("POST", `/v1/artifacts/${artifact.id}/versions`, {
						version: 2,
						files: invalid,
					})).status,
				).toBe(409)
				expect(
					(yield* call("POST", "/v1/artifacts/art_missing/versions", {
						version: 1,
						files: invalid,
					})).status,
				).toBe(404)
				expect(
					(yield* call("POST", `/v1/artifacts/${artifact.id}/versions`, {
						version: 1,
						files: invalid,
					})).status,
				).toBe(400)
				expect(
					(yield* call("POST", `/v1/artifacts/${artifact.id}/versions`, {
						version: 1,
						files: [{ path: "a.txt", content: "b" }],
					})).status,
				).toBe(201)
				expect(
					(yield* call("POST", `/v1/artifacts/${artifact.id}/versions`, {
						version: 1,
						files: invalid,
					})).status,
				).toBe(409)
			}),
		))

	it("keeps no bytes for a version that was refused", () =>
		withApi(({ call, store }) =>
			Effect.gen(function* () {
				yield* call("POST", "/v1/artifacts/art_missing/versions", {
					version: 1,
					files: [{ path: "a.txt", content: "orphan" }],
				})
				expect([...store.objects.keys()]).toEqual([])

				const artifact = yield* json<ArtifactBody>(
					yield* call("POST", "/v1/artifacts", {
						name: "A",
						files: [{ path: "a.txt", content: "a" }],
					}),
				)
				const before = [...store.objects.keys()].sort()
				yield* call("POST", `/v1/artifacts/${artifact.id}/versions`, {
					version: 7,
					files: [{ path: "a.txt", content: "stale" }],
				})
				expect([...store.objects.keys()].sort()).toEqual(before)
			}),
		))

	it("rejects unsafe paths, duplicates, bad base64, and oversized uploads with 400", () =>
		withApi(({ call }) =>
			Effect.gen(function* () {
				const create = (files: ReadonlyArray<unknown>) =>
					Effect.map(call("POST", "/v1/artifacts", { name: "A", files }), (res) => res.status)
				for (const path of [
					"",
					"/abs.txt",
					"../up.txt",
					"a/../b.txt",
					"a/./b.txt",
					"a//b.txt",
					"a/",
					String.raw`a\b.txt`,
					"a\nb.txt",
					".",
					"..",
					"x".repeat(513),
					String.fromCodePoint(0x1_f6_00).repeat(513),
					`a${String.fromCodePoint(0xd8_00)}`,
					`a${String.fromCodePoint(0x20_28)}b.txt`,
				]) {
					expect(yield* create([{ path, content: "x" }]), JSON.stringify(path)).toBe(400)
				}
				const joiner = String.fromCodePoint(0x20_0d)
				for (const path of [
					"a.txt",
					".well-known/x",
					"a..b/c.d",
					"dir/sub/file name.txt",
					"..a",
					`family${joiner}emoji.png`,
					String.fromCodePoint(0x1_f6_00).repeat(512),
					`${String.fromCodePoint(0x6_45, 0x6_cc, 0x20_0c, 0x6_2e)}.txt`,
				]) {
					expect(yield* create([{ path, content: "x" }]), JSON.stringify(path)).toBe(201)
				}
				expect(yield* create([])).toBe(400)
				expect(
					yield* create([
						{ path: "a.txt", content: "1" },
						{ path: "a.txt", content: "2" },
					]),
				).toBe(400)
				expect(yield* create([{ path: "a.bin", content: "***", encoding: "base64" }])).toBe(400)
				for (const paths of [
					["docs", "docs/index.md"],
					["docs/index.md", "docs"],
					["a/b", "a/b/c/d.txt"],
				]) {
					expect(
						yield* create(paths.map((path) => ({ path, content: "x" }))),
						paths.join(" + "),
					).toBe(400)
				}
				for (const paths of [
					["docs-old", "docs/x"],
					["a/b", "a/bc/d"],
					["a/b.txt", "a/b/c"],
				]) {
					expect(
						yield* create(paths.map((path) => ({ path, content: "x" }))),
						paths.join(" + "),
					).toBe(201)
				}
				expect(
					yield* create([{ path: "a.txt", content: "x", content_type: "text/html\r\nx: y" }]),
				).toBe(400)
				expect(
					yield* create([
						{
							path: "a.txt",
							content: "x",
							content_type: `text/${String.fromCodePoint(0x1_7f)}tuff`,
						},
					]),
				).toBe(400)
				expect(
					yield* create([
						{ path: "a.txt", content: "x", content_type: "Text/HTML; charset=UTF-8" },
					]),
				).toBe(201)
				for (const content_type of [
					'video/mp4; codecs="avc1.42E01E"',
					"text/plain; charset=utf-8; format=flowed",
				]) {
					expect(yield* create([{ path: "a.bin", content: "x", content_type }])).toBe(201)
				}
				expect(
					yield* create([{ path: "a.txt", content: `a${String.fromCodePoint(0xd8_00)}b` }]),
				).toBe(400)
				expect(
					yield* create(
						Array.from({ length: MAX_ARTIFACT_FILES + 1 }, (_, index) => ({
							path: `f${index}.txt`,
							content: "x",
						})),
					),
				).toBe(400)
				expect(
					yield* create([{ path: "big.txt", content: "x".repeat(MAX_ARTIFACT_FILE_BYTES + 1) }]),
				).toBe(400)
				const chunk = "x".repeat(MAX_ARTIFACT_FILE_BYTES)
				const count = Math.floor(MAX_ARTIFACT_TOTAL_BYTES / MAX_ARTIFACT_FILE_BYTES)
				expect(
					yield* create(
						Array.from({ length: count }, (_, index) => ({ path: `f${index}`, content: chunk })),
					),
				).toBe(201)
				expect(
					yield* create([
						...Array.from({ length: count }, (_, index) => ({ path: `f${index}`, content: chunk })),
						{ path: "one-more", content: "x" },
					]),
				).toBe(400)
			}),
		))

	it("replays an idempotent create and refuses the key for different files", () =>
		withApi(({ call }) =>
			Effect.gen(function* () {
				const body = { name: "A", files: [{ path: "a.txt", content: "a" }] }
				const headers = { "idempotency-key": "artifact-1" }
				const first = yield* json<ArtifactBody>(yield* call("POST", "/v1/artifacts", body, headers))
				const replay = yield* call("POST", "/v1/artifacts", body, headers)
				expect(replay.status).toBe(201)
				expect(yield* json<ArtifactBody>(replay)).toEqual(first)
				const changed = yield* call(
					"POST",
					"/v1/artifacts",
					{ name: "A", files: [{ path: "a.txt", content: "b" }] },
					headers,
				)
				expect(changed.status).toBe(409)
				expect(yield* json<unknown>(changed)).toMatchObject({
					type: "error",
					error: {
						type: "conflict_error",
						message: "Idempotency-Key was already used for a different request.",
					},
				})
				const renamed = yield* call("POST", "/v1/artifacts", { ...body, name: "B" }, headers)
				expect(renamed.status).toBe(409)
				expect(yield* json<ArtifactBody>(yield* call("GET", `/v1/artifacts/${first.id}`))).toEqual(
					first,
				)
				expect((yield* call("DELETE", `/v1/artifacts/${first.id}`)).status).toBe(200)
				const changedAfterDelete = yield* call(
					"POST",
					"/v1/artifacts",
					{ ...body, name: "B" },
					headers,
				)
				expect(changedAfterDelete.status).toBe(409)
				expect((yield* call("POST", "/v1/artifacts", body, headers)).status).toBe(404)
			}),
		))

	it("writes no bytes for an artifact that is already deleted", () =>
		withApi(({ call, store }) =>
			Effect.gen(function* () {
				const body = { name: "A", files: [{ path: "a.txt", content: "a" }] }
				const headers = { "idempotency-key": "gone" }
				const artifact = yield* json<ArtifactBody>(
					yield* call("POST", "/v1/artifacts", body, headers),
				)
				expect((yield* call("DELETE", `/v1/artifacts/${artifact.id}`)).status).toBe(200)
				expect((yield* call("POST", "/v1/artifacts", body, headers)).status).toBe(404)
				expect([...store.objects.keys()]).toEqual([])

				const racing = yield* json<ArtifactBody>(yield* call("POST", "/v1/artifacts", body))
				store.setBeforePut(
					Effect.asVoid(call("DELETE", `/v1/artifacts/${racing.id}`)).pipe(
						Effect.andThen(Effect.sync(() => store.setBeforePut(Effect.void))),
					),
				)
				const added = yield* call("POST", `/v1/artifacts/${racing.id}/versions`, {
					version: 1,
					files: [{ path: "a.txt", content: "late" }],
				})
				expect(added.status).toBe(404)
				expect([...store.objects.keys()]).toEqual([])
			}),
		))

	it("returns a file's exact text, including a leading byte order mark", () =>
		withApi(({ call }) =>
			Effect.gen(function* () {
				const content = `${String.fromCodePoint(0xfe_ff)}hi`
				const artifact = yield* json<ArtifactBody>(
					yield* call("POST", "/v1/artifacts", {
						name: "A",
						files: [{ path: "bom.txt", content }],
					}),
				)
				const file = yield* json<FileBody>(
					yield* call("GET", `/v1/artifacts/${artifact.id}/versions/1/file?file=bom.txt`),
				)
				expect(file).toMatchObject({ encoding: "utf8", size: 5, content })
			}),
		))

	it("accepts escaped uploads past the default body limit on create and on new versions", () =>
		withApi(({ call }) =>
			Effect.gen(function* () {
				const newlines = "\n".repeat(MAX_ARTIFACT_FILE_BYTES)
				const files = [0, 1, 2].map((index) => ({ path: `f${index}.txt`, content: newlines }))
				expect(JSON.stringify({ files }).length).toBeGreaterThan(MAX_ARTIFACT_TOTAL_BYTES)
				const created = yield* call("POST", "/v1/artifacts", { name: "A", files })
				expect(created.status).toBe(201)
				const artifact = yield* json<ArtifactBody>(created)
				const medium = [{ path: "a.txt", content: "x".repeat(MAX_REQUEST_BODY_BYTES * 2) }]
				expect(
					(yield* call("POST", `/v1/artifacts/${artifact.id}/versions`, {
						version: 1,
						files: medium,
					})).status,
				).toBe(201)
				const oversized = [{ path: "a.txt", content: "\n".repeat(MAX_ARTIFACT_BODY_BYTES) }]
				const refusedCreate = yield* call("POST", "/v1/artifacts", { name: "A", files: oversized })
				expect(refusedCreate.status).toBe(413)
				expect((yield* json<ErrorBody>(refusedCreate)).error.message).toBe(
					ARTIFACT_BODY_TOO_LARGE_MESSAGE,
				)
				const refusedVersion = yield* call("POST", `/v1/artifacts/${artifact.id}/versions`, {
					version: 2,
					files: oversized,
				})
				expect(refusedVersion.status).toBe(413)
				expect((yield* json<ErrorBody>(refusedVersion)).error.message).toBe(
					ARTIFACT_BODY_TOO_LARGE_MESSAGE,
				)

				const nul = String.fromCodePoint(0).repeat(MAX_ARTIFACT_FILE_BYTES)
				const count = MAX_ARTIFACT_TOTAL_BYTES / MAX_ARTIFACT_FILE_BYTES
				const nulFiles = Array.from({ length: count }, (_, index) => ({
					path: `n${index}.bin`,
					content: nul,
				}))
				expect(JSON.stringify({ name: "A", files: nulFiles }).length).toBeGreaterThan(
					MAX_ARTIFACT_TOTAL_BYTES * 6,
				)
				const escaped = yield* call("POST", "/v1/artifacts", { name: "A", files: nulFiles })
				expect(escaped.status).toBe(413)
				expect((yield* json<ErrorBody>(escaped)).error.message).toBe(
					ARTIFACT_BODY_TOO_LARGE_MESSAGE,
				)
				const base64 = yield* call("POST", "/v1/artifacts", {
					name: "A",
					files: nulFiles.map((file) => ({
						path: file.path,
						content: Base64.encode(new TextEncoder().encode(file.content)),
						encoding: "base64",
					})),
				})
				expect(base64.status).toBe(201)
				expect((yield* json<ArtifactBody>(base64)).total_bytes).toBe(MAX_ARTIFACT_TOTAL_BYTES)

				const otherRefusal = yield* call("POST", "/v1/agents", {
					name: "A",
					model: "gpt-6.2-sol",
					system: "x".repeat(MAX_ARTIFACT_BODY_BYTES),
				})
				expect(otherRefusal.status).toBe(413)
				expect((yield* json<ErrorBody>(otherRefusal)).error.message).toBe(
					"Request body is too large.",
				)
			}),
		))

	it("accepts a full version of two-byte text sent as ASCII escapes", () =>
		withApi(({ postRaw }) =>
			Effect.gen(function* () {
				const escaped = `${String.fromCodePoint(0x5c)}u0436`.repeat(MAX_ARTIFACT_FILE_BYTES / 2)
				const count = MAX_ARTIFACT_TOTAL_BYTES / MAX_ARTIFACT_FILE_BYTES
				const files = Array.from(
					{ length: count },
					(_, index) => `{"path":"f${index}.txt","content":"${escaped}"}`,
				)
				const body = `{"name":"A","files":[${files.join(",")}]}`
				expect(body.length).toBeGreaterThan(MAX_ARTIFACT_TOTAL_BYTES * 2.9)
				const created = yield* postRaw("/v1/artifacts", body)
				expect(created.status).toBe(201)
				expect((yield* json<ArtifactBody>(created)).total_bytes).toBe(MAX_ARTIFACT_TOTAL_BYTES)
			}),
		))

	it("answers 404, not 500, when a delete removes the bytes mid-read", () =>
		withApi(({ call, store }) =>
			Effect.gen(function* () {
				const artifact = yield* json<ArtifactBody>(
					yield* call("POST", "/v1/artifacts", {
						name: "A",
						files: [{ path: "a.txt", content: "a" }],
					}),
				)
				store.setBeforeGet(
					Effect.asVoid(call("DELETE", `/v1/artifacts/${artifact.id}`)).pipe(
						Effect.andThen(Effect.sync(() => store.setBeforeGet(Effect.void))),
					),
				)
				expect((yield* call("GET", `/v1/artifacts/${artifact.id}/versions/1`)).status).toBe(404)
			}),
		))

	it("waits for an older version row the view has not served yet", () =>
		withApi(({ call, callLagging }) =>
			Effect.gen(function* () {
				const artifact = yield* json<ArtifactBody>(
					yield* call("POST", "/v1/artifacts", {
						name: "A",
						files: [{ path: "a.txt", content: "a" }],
					}),
				)
				yield* call("POST", `/v1/artifacts/${artifact.id}/versions`, {
					version: 1,
					files: [{ path: "b.txt", content: "b" }],
				})
				const version = yield* callLagging(`/v1/artifacts/${artifact.id}/versions/1`)
				expect(version.status).toBe(200)
				expect((yield* json<VersionBody>(version)).files.map((file) => file.path)).toEqual([
					"a.txt",
				])
				expect((yield* callLagging(`/v1/artifacts/${artifact.id}/versions/3`)).status).toBe(404)
			}),
		))

	it("builds every head read from the artifact and its manifest, never from a view", () =>
		withApi(({ call, callViewless, viewReads }) =>
			Effect.gen(function* () {
				const created = yield* callViewless("POST", "/v1/artifacts", {
					name: "A",
					files: [{ path: "a.txt", content: "one" }],
				})
				expect(created.status).toBe(201)
				const artifact = yield* json<ArtifactBody>(created)
				expect(artifact).toMatchObject({ version: 1, file_count: 1, total_bytes: 3 })
				expect(artifact.updated_at).toBe(artifact.created_at)
				const added = yield* callViewless("POST", `/v1/artifacts/${artifact.id}/versions`, {
					version: 1,
					files: [
						{ path: "b.txt", content: "two" },
						{ path: "c.txt", content: "three" },
					],
				})
				expect(added.status).toBe(201)
				expect(yield* json<VersionBody>(added)).toMatchObject({
					version: 2,
					file_count: 2,
					total_bytes: 8,
				})
				const head = yield* json<ArtifactBody>(
					yield* callViewless("GET", `/v1/artifacts/${artifact.id}`),
				)
				expect(head).toMatchObject({ version: 2, name: "A", file_count: 2, total_bytes: 8 })
				expect(head.created_at).toBe(artifact.created_at)
				expect(head.files.map((file) => file.path)).toEqual(["b.txt", "c.txt"])
				expect((yield* callViewless("GET", `/v1/artifacts/${artifact.id}/versions/2`)).status).toBe(
					200,
				)
				expect(
					(yield* callViewless("GET", `/v1/artifacts/${artifact.id}/versions/2/file?file=c.txt`))
						.status,
				).toBe(200)
				const link = yield* callViewless(
					"POST",
					`/v1/artifacts/${artifact.id}/versions/1/links`,
					{},
				)
				expect(link.status).toBe(201)
				expect(viewReads()).toBe(0)
				const older = yield* call("GET", `/v1/artifacts/${artifact.id}/versions/1`)
				expect(older.status).toBe(200)
				expect(
					(yield* callViewless("GET", `/v1/artifacts/${artifact.id}/versions/1`)).status,
				).not.toBe(200)
				expect(viewReads()).toBeGreaterThan(0)
			}),
		))

	it("answers a read from the one state it read, though a version lands before the reply", () =>
		withApi(({ call, callInterleaved, afterNextRead }) =>
			Effect.gen(function* () {
				const { id } = yield* json<ArtifactBody>(
					yield* call("POST", "/v1/artifacts", {
						name: "A",
						files: [{ path: "a.txt", content: "one" }],
					}),
				)
				afterNextRead(
					Effect.asVoid(
						call("POST", `/v1/artifacts/${id}/versions`, {
							version: 1,
							files: [{ path: "b.txt", content: "two" }],
						}),
					),
				)
				const head = yield* json<ArtifactBody>(yield* callInterleaved("GET", `/v1/artifacts/${id}`))
				expect(head).toMatchObject({ version: 1, file_count: 1, total_bytes: 3 })
				expect(head.files.map((file) => file.path)).toEqual(["a.txt"])
				expect(head.updated_at).toBe(head.created_at)
				const now = yield* json<ArtifactBody>(yield* call("GET", `/v1/artifacts/${id}`))
				expect(now.version).toBe(2)
				expect(now.files.map((file) => file.path)).toEqual(["b.txt"])
			}),
		))

	it("writes nothing back for a keyed replay after delete, even while the head view lags", () =>
		withApi(({ callViewless, store }) =>
			Effect.gen(function* () {
				const body = { name: "A", files: [{ path: "a.txt", content: "a" }] }
				const headers = { "idempotency-key": "replay-after-delete" }
				const created = yield* callViewless("POST", "/v1/artifacts", body, headers)
				expect(created.status).toBe(201)
				const { id } = yield* json<ArtifactBody>(created)
				expect((yield* callViewless("DELETE", `/v1/artifacts/${id}`)).status).toBe(200)
				expect([...store.objects.keys()]).toEqual([])
				expect((yield* callViewless("POST", "/v1/artifacts", body, headers)).status).toBe(404)
				expect([...store.objects.keys()]).toEqual([])
				store.setFailing(true)
				expect((yield* callViewless("POST", "/v1/artifacts", body, headers)).status).toBe(404)
				store.setFailing(false)
			}),
		))

	it("leaves nothing behind when a delete lands while a keyed create is writing", () =>
		withApi(({ callViewless, store }) =>
			Effect.gen(function* () {
				const body = { name: "A", files: [{ path: "a.txt", content: "a" }] }
				const headers = { "idempotency-key": "delete-during-write" }
				store.setBeforePut(
					Effect.gen(function* () {
						store.setBeforePut(Effect.void)
						const inner = yield* callViewless("POST", "/v1/artifacts", body, headers)
						const { id } = yield* json<ArtifactBody>(inner)
						yield* callViewless("DELETE", `/v1/artifacts/${id}`)
					}),
				)
				expect((yield* callViewless("POST", "/v1/artifacts", body, headers)).status).toBe(404)
				expect([...store.objects.keys()]).toEqual([])
			}),
		))

	it("releases the partial upload of a create that storage refused part-way once its reservation expires", () =>
		withApi(({ call, store, expire, reservationsOf }) =>
			Effect.gen(function* () {
				store.setFailManifest(true)
				const failed = yield* call("POST", "/v1/artifacts", {
					name: "A",
					files: [
						{ path: "a.txt", content: "a" },
						{ path: "b.txt", content: "b" },
					],
				})
				expect(failed.status).toBe(503)
				store.setFailManifest(false)
				const [id, ...others] = artifactIdsIn(store)
				expect(others).toEqual([])
				expect(store.objects.size).toBe(2)
				yield* expire(id ?? "", (yield* reservationsOf(id ?? "")).open)
				yield* eventually(
					Effect.sync(() => store.objects.size === 0),
					"the partial upload is released",
				)
			}),
		))

	it("reads the head at the version the artifact has committed, not an older projection", () =>
		withApi(({ call, callViewless }) =>
			Effect.gen(function* () {
				const { id } = yield* json<ArtifactBody>(
					yield* call("POST", "/v1/artifacts", {
						name: "A",
						files: [{ path: "a.txt", content: "one" }],
					}),
				)
				expect(
					(yield* json<ArtifactBody>(yield* callViewless("GET", `/v1/artifacts/${id}`))).version,
				).toBe(1)
				yield* call("POST", `/v1/artifacts/${id}/versions`, {
					version: 1,
					files: [{ path: "b.txt", content: "two" }],
				})
				const head = yield* json<ArtifactBody>(yield* callViewless("GET", `/v1/artifacts/${id}`))
				expect(head.version).toBe(2)
				expect(head.files.map((file) => file.path)).toEqual(["b.txt"])
			}),
		))

	it("answers a keyed replay with the artifact as its create made it", () =>
		withApi(({ call }) =>
			Effect.gen(function* () {
				const body = { name: "A", files: [{ path: "a.txt", content: "one" }] }
				const headers = { "idempotency-key": "create-as-made" }
				const created = yield* json<ArtifactBody>(
					yield* call("POST", "/v1/artifacts", body, headers),
				)
				yield* call("POST", `/v1/artifacts/${created.id}/versions`, {
					version: 1,
					files: [{ path: "b.txt", content: "two" }],
				})
				expect((yield* call("POST", `/v1/artifacts/${created.id}/publication`, {})).status).toBe(
					200,
				)
				expect(created).toMatchObject({ publication: null })
				expect(
					yield* json<ArtifactBody>(yield* call("POST", "/v1/artifacts", body, headers)),
				).toEqual(created)
			}),
		))

	it("names the committed version in a pending version receipt", () =>
		withApi(({ call, steerReads, callSteered }) =>
			Effect.gen(function* () {
				const artifact = yield* json<ArtifactBody>(
					yield* call("POST", "/v1/artifacts", {
						name: "A",
						files: [{ path: "a.txt", content: "a" }],
					}),
				)
				steerReads((n) => (n === 2 ? "die" : "real"))
				const pending = yield* callSteered("POST", `/v1/artifacts/${artifact.id}/versions`, {
					version: 1,
					files: [{ path: "a.txt", content: "b" }],
				})
				expect(pending.status).toBe(202)
				expect(yield* json<unknown>(pending)).toEqual({
					id: artifact.id,
					type: "artifact_version",
					version: 2,
					pending: true,
				})
				const version = yield* call("GET", `/v1/artifacts/${artifact.id}/versions/2`)
				expect(version.status).toBe(200)
			}),
		))

	it("answers 202 with the id when the read after a committed create fails", () =>
		withApi(({ call, steerReads, callSteered }) =>
			Effect.gen(function* () {
				steerReads((n) => (n === 2 ? "die" : "real"))
				const created = yield* callSteered("POST", "/v1/artifacts", {
					name: "A",
					files: [{ path: "a.txt", content: "a" }],
				})
				expect(created.status).toBe(202)
				const pending = yield* json<{ id: string; type: string; pending: boolean }>(created)
				expect(pending).toMatchObject({ type: "artifact", pending: true })
				expect((yield* call("GET", `/v1/artifacts/${pending.id}`)).status).toBe(200)
			}),
		))

	it("lets a delete that overlapped another delete finish with 200 and purge", () =>
		withApi(({ call, steerReads, callSteered, store }) =>
			Effect.gen(function* () {
				const { id } = yield* json<ArtifactBody>(
					yield* call("POST", "/v1/artifacts", {
						name: "A",
						files: [{ path: "a.txt", content: "a" }],
					}),
				)
				steerReads((n) => (n === 2 ? "stale" : "real"))
				yield* callSteered("GET", `/v1/artifacts/${id}`)
				store.setBeforeDelete(Effect.sync(() => store.setFailing(true)))
				expect((yield* call("DELETE", `/v1/artifacts/${id}`)).status).toBe(503)
				store.setBeforeDelete(Effect.void)
				store.setFailing(false)
				expect([...store.objects.keys()].length).toBeGreaterThan(0)
				const overlapping = yield* callSteered("DELETE", `/v1/artifacts/${id}`)
				expect(overlapping.status).toBe(200)
				expect([...store.objects.keys()]).toEqual([])
			}),
		))

	it("deletes a prefix page by page until nothing is left", async () => {
		const keys = new Set(Array.from({ length: 2500 }, (_, index) => `k${index}`))
		const pages: Array<number> = []
		await Effect.runPromise(
			deleteUntilEmpty(
				Effect.sync(() => [...keys].slice(0, 1000)),
				(page) =>
					Effect.sync(() => {
						pages.push(page.length)
						for (const key of page) {
							keys.delete(key)
						}
					}),
			),
		)
		expect(pages).toEqual([1000, 1000, 500])
		expect(keys.size).toBe(0)
	})

	it("deletes the artifact and every stored byte, and a repeated delete finishes a failed purge", () =>
		withApi(({ call, store }) =>
			Effect.gen(function* () {
				const keep = yield* json<ArtifactBody>(
					yield* call("POST", "/v1/artifacts", {
						name: "Keep",
						files: [{ path: "a.txt", content: "keep" }],
					}),
				)
				const artifact = yield* json<ArtifactBody>(
					yield* call("POST", "/v1/artifacts", {
						name: "Drop",
						files: [{ path: "a.txt", content: "drop" }],
					}),
				)
				const owned = () =>
					[...store.objects.keys()].filter((key) =>
						key.startsWith(artifactPrefix(SCOPE, artifact.id)),
					)
				expect(owned()).toHaveLength(2)

				store.setBeforeDelete(Effect.sync(() => store.setFailing(true)))
				expect((yield* call("DELETE", `/v1/artifacts/${artifact.id}`)).status).toBe(503)
				store.setBeforeDelete(Effect.void)
				store.setFailing(false)
				expect(owned()).toHaveLength(2)
				expect((yield* call("GET", `/v1/artifacts/${artifact.id}`)).status).toBe(404)
				expect((yield* call("GET", `/v1/artifacts/${artifact.id}/versions/1`)).status).toBe(404)
				expect(
					(yield* call("GET", `/v1/artifacts/${artifact.id}/versions/1/file?file=a.txt`)).status,
				).toBe(404)

				const again = yield* call("DELETE", `/v1/artifacts/${artifact.id}`)
				expect(again.status).toBe(200)
				expect(yield* json<{ id: string; type: string }>(again)).toEqual({
					id: artifact.id,
					type: "artifact_deleted",
				})
				expect(owned()).toEqual([])
				expect(
					[...store.objects.keys()].filter((key) => key.startsWith(artifactPrefix(SCOPE, keep.id))),
				).toHaveLength(2)
				expect(
					(yield* call("POST", `/v1/artifacts/${artifact.id}/versions`, {
						version: 1,
						files: [{ path: "a.txt", content: "back" }],
					})).status,
				).toBe(404)
			}),
		))

	it("keeps the files and deletes of each jurisdiction apart", () =>
		withApi(({ call, store, build, serviceIn }) =>
			Effect.gen(function* () {
				const files = [{ path: "a.txt", content: "a" }]
				const { id } = yield* json<ArtifactBody>(
					yield* call("POST", "/v1/artifacts", { name: "A", files }),
				)
				const eu = yield* serviceIn("eu")
				const built = yield* build(files)
				yield* Effect.orDie(eu.stage(id, built, null))
				const keysIn = (scope: string) =>
					[...store.objects.keys()]
						.flatMap((key) =>
							key.startsWith(artifactPrefix(scope, id))
								? [key.slice(artifactPrefix(scope, id).length)]
								: [],
						)
						.sort()
				const euKeys = keysIn("eu")
				expect(euKeys).toHaveLength(2)
				expect(keysIn(SCOPE)).toEqual(euKeys)

				expect((yield* call("DELETE", `/v1/artifacts/${id}`)).status).toBe(200)
				expect(keysIn(SCOPE)).toEqual([])
				expect(keysIn("eu")).toEqual(euKeys)
				const [blob] = built.blobs
				expect(yield* Effect.orDie(eu.getBlob(id, blob?.sha256 ?? ""))).toEqual(blob?.bytes)
			}),
		))

	it("answers 503 and commits nothing when storage is down", () =>
		withApi(({ call, store, statusForKey }) =>
			Effect.gen(function* () {
				store.setFailing(true)
				const failed = yield* call(
					"POST",
					"/v1/artifacts",
					{ name: "A", files: [{ path: "a.txt", content: "a" }] },
					{ "idempotency-key": "retry-me" },
				)
				expect(failed.status).toBe(503)
				store.setFailing(false)
				expect(yield* statusForKey("retry-me")).toBe("")
				const retried = yield* call(
					"POST",
					"/v1/artifacts",
					{ name: "A", files: [{ path: "a.txt", content: "a" }] },
					{ "idempotency-key": "retry-me" },
				)
				expect(retried.status).toBe(201)
				const artifact = yield* json<ArtifactBody>(retried)
				expect(artifact.version).toBe(1)
				expect(
					(yield* call("GET", `/v1/artifacts/${artifact.id}/versions/1/file?file=a.txt`)).status,
				).toBe(200)
			}),
		))

	it("commits the winner's version and serves nothing of the loser's when two writers race", () =>
		withApi(({ call, store }) =>
			Effect.gen(function* () {
				const shared = { path: "shared.txt", content: "shared" }
				const { id } = yield* json<ArtifactBody>(
					yield* call("POST", "/v1/artifacts", {
						name: "A",
						files: [shared, { path: "one.txt", content: "one" }],
					}),
				)
				let winner: Response | undefined
				store.setBeforePut(
					Effect.gen(function* () {
						store.setBeforePut(Effect.void)
						winner = yield* call("POST", `/v1/artifacts/${id}/versions`, {
							version: 1,
							files: [shared, { path: "b.txt", content: "winner" }],
						})
					}),
				)
				const loser = yield* call("POST", `/v1/artifacts/${id}/versions`, {
					version: 1,
					files: [shared, { path: "a.txt", content: "loser" }],
				})
				expect(winner?.status).toBe(201)
				expect(loser.status).toBe(409)
				const read = (version: number, path: string) =>
					call("GET", `/v1/artifacts/${id}/versions/${version}/file?file=${path}`)
				expect((yield* json<FileBody>(yield* read(1, "one.txt"))).content).toBe("one")
				expect((yield* json<FileBody>(yield* read(2, "shared.txt"))).content).toBe("shared")
				expect((yield* json<FileBody>(yield* read(2, "b.txt"))).content).toBe("winner")
				expect((yield* read(2, "a.txt")).status).toBe(404)
				expect((yield* call("DELETE", `/v1/artifacts/${id}`)).status).toBe(200)
				expect(store.objects.size).toBe(0)
			}),
		))

	it("keeps the head version intact when a version's upload fails part-way", () =>
		withApi(({ call, store }) =>
			Effect.gen(function* () {
				const { id } = yield* json<ArtifactBody>(
					yield* call("POST", "/v1/artifacts", {
						name: "A",
						files: [{ path: "a.txt", content: "a" }],
					}),
				)
				store.setFailManifest(true)
				const failed = yield* call("POST", `/v1/artifacts/${id}/versions`, {
					version: 1,
					files: [
						{ path: "a.txt", content: "a" },
						{ path: "b.txt", content: "new" },
					],
				})
				store.setFailManifest(false)
				expect(failed.status).toBe(503)
				expect((yield* json<ArtifactBody>(yield* call("GET", `/v1/artifacts/${id}`))).version).toBe(
					1,
				)
				const file = yield* call("GET", `/v1/artifacts/${id}/versions/1/file?file=a.txt`)
				expect((yield* json<FileBody>(file)).content).toBe("a")
			}),
		))

	it("finishes a keyed create on retry after its first attempt failed part-way", () =>
		withApi(({ call, store, statusForKey }) =>
			Effect.gen(function* () {
				const body = {
					name: "A",
					files: [
						{ path: "a.txt", content: "a" },
						{ path: "b.txt", content: "b" },
					],
				}
				const headers = { "idempotency-key": "partial" }
				store.setFailManifest(true)
				expect((yield* call("POST", "/v1/artifacts", body, headers)).status).toBe(503)
				expect(yield* statusForKey("partial")).toBe("")
				store.setFailManifest(false)
				const retried = yield* call("POST", "/v1/artifacts", body, headers)
				expect(retried.status).toBe(201)
				const { id } = yield* json<ArtifactBody>(retried)
				for (const file of body.files) {
					const read = yield* call("GET", `/v1/artifacts/${id}/versions/1/file?file=${file.path}`)
					expect((yield* json<FileBody>(read)).content).toBe(file.content)
				}
			}),
		))

	it("stores a file a new version keeps without writing it again", () =>
		withApi(({ call, store, build }) =>
			Effect.gen(function* () {
				const keep = { path: "keep.txt", content: "keep" }
				const { id } = yield* json<ArtifactBody>(
					yield* call("POST", "/v1/artifacts", {
						name: "A",
						files: [keep, { path: "a.txt", content: "1" }],
					}),
				)
				const [blob] = (yield* build([keep])).blobs
				const key = artifactBlobKey(SCOPE, id, blob?.sha256 ?? "")
				expect(store.putCount(key)).toBe(1)
				for (const version of [1, 2]) {
					const added = yield* call("POST", `/v1/artifacts/${id}/versions`, {
						version,
						files: [keep, { path: "b.txt", content: String(version) }],
					})
					expect(added.status).toBe(201)
				}
				expect(store.putCount(key)).toBe(1)
			}),
		))

	it("keeps a file of the replaced version by its sha256, without sending or storing it again", () =>
		withApi(({ call, store }) =>
			Effect.gen(function* () {
				const created = yield* json<ArtifactBody>(
					yield* call("POST", "/v1/artifacts", {
						name: "Site",
						files: [
							{ path: "index.html", content: "<h1>home</h1>" },
							{ path: "app.js", content: "start()" },
						],
					}),
				)
				const sha = (path: string) => created.files.find((file) => file.path === path)?.sha256 ?? ""
				const key = artifactBlobKey(SCOPE, created.id, sha("app.js"))
				const body = {
					version: 1,
					files: [
						{ path: "index.html", content: "<h1>fixed</h1>" },
						{ path: "app.js", sha256: sha("app.js") },
						{ path: "old/index.html", sha256: sha("index.html") },
					],
				}
				const added = yield* call("POST", `/v1/artifacts/${created.id}/versions`, body)
				expect(added.status).toBe(201)
				const version = yield* json<VersionBody>(added)
				expect(version.files.map((file) => [file.path, file.content_type])).toEqual([
					["app.js", "text/javascript"],
					["index.html", "text/html"],
					["old/index.html", "text/html"],
				])
				expect(version.total_bytes).toBe(
					"<h1>fixed</h1>".length + "start()".length + "<h1>home</h1>".length,
				)
				expect(store.putCount(key)).toBe(1)
				const read = (path: string) =>
					Effect.flatMap(
						call("GET", `/v1/artifacts/${created.id}/versions/2/file?file=${path}`),
						json<FileBody>,
					)
				expect((yield* read("app.js")).content).toBe("start()")
				expect((yield* read("old/index.html")).content).toBe("<h1>home</h1>")

				const resent = yield* call("POST", `/v1/artifacts/${created.id}/versions`, body)
				expect(resent.status).toBe(201)
				expect((yield* json<VersionBody>(resent)).version).toBe(2)

				const missing = yield* call("POST", `/v1/artifacts/${created.id}/versions`, {
					version: 2,
					files: [{ path: "gone.txt", sha256: "0".repeat(64) }],
				})
				expect(missing.status).toBe(400)
				expect((yield* json<ErrorBody>(missing)).error.message).toContain("does not hold")
				const onCreate = yield* call("POST", "/v1/artifacts", {
					name: "New",
					files: [{ path: "a.txt", sha256: sha("app.js") }],
				})
				expect(onCreate.status).toBe(400)
			}),
		))

	it("answers a resent version that kept files with the committed version, without reading a view", () =>
		withApi(({ call, callViewless, viewReads }) =>
			Effect.gen(function* () {
				const created = yield* json<ArtifactBody>(
					yield* call("POST", "/v1/artifacts", {
						name: "Site",
						files: [
							{ path: "index.html", content: "<h1>home</h1>" },
							{ path: "app.js", content: "start()" },
						],
					}),
				)
				const kept = created.files.find((file) => file.path === "app.js")?.sha256 ?? ""
				const body = {
					version: 1,
					files: [
						{ path: "index.html", content: "<h1>fixed</h1>" },
						{ path: "app.js", sha256: kept },
					],
				}
				const path = `/v1/artifacts/${created.id}/versions`
				expect((yield* call("POST", path, body)).status).toBe(201)
				const resent = yield* callViewless("POST", path, body)
				expect(resent.status).toBe(201)
				const replayed = yield* json<VersionBody>(resent)
				expect(replayed.version).toBe(2)
				const changed = yield* callViewless("POST", path, {
					...body,
					files: [{ path: "app.js", sha256: kept }],
				})
				expect(changed.status).toBe(409)
				const introduced = replayed.files.find((file) => file.path === "index.html")?.sha256
				const impossible = yield* callViewless("POST", path, {
					version: 1,
					files: [
						{ path: "index.html", sha256: introduced ?? "" },
						{ path: "app.js", sha256: kept },
					],
				})
				expect(impossible.status).toBe(409)
				expect(viewReads()).toBe(0)
			}),
		))

	it("lists each artifact's size and publication without its files or a storage read", () =>
		withApi(({ call, store }) =>
			Effect.gen(function* () {
				const { id } = yield* json<ArtifactBody>(
					yield* call("POST", "/v1/artifacts", {
						name: "Listed",
						files: [
							{ path: "a.txt", content: "aa" },
							{ path: "b.txt", content: "bbb" },
						],
					}),
				)
				yield* call("POST", `/v1/artifacts/${id}/versions`, {
					version: 1,
					files: [{ path: "c.txt", content: "c" }],
				})
				let reads = 0
				store.setBeforeGet(
					Effect.sync(() => {
						reads += 1
					}),
				)
				const page = yield* json<{
					readonly data: ReadonlyArray<Omit<ArtifactBody, "files"> & { readonly files?: never }>
				}>(yield* call("GET", "/v1/artifacts"))
				store.setBeforeGet(Effect.void)
				const listed = page.data.find((artifact) => artifact.id === id)
				expect(listed).toMatchObject({
					version: 2,
					file_count: 1,
					total_bytes: 1,
					publication: null,
				})
				expect(listed).not.toHaveProperty("files")
				expect(reads).toBe(0)
			}),
		))

	it("keeps the files of a version that never committed until the artifact is deleted", () =>
		withApi(({ call, store, service, build }) =>
			Effect.gen(function* () {
				const { id } = yield* json<ArtifactBody>(
					yield* call("POST", "/v1/artifacts", {
						name: "A",
						files: [{ path: "a.txt", content: "a" }],
					}),
				)
				const before = store.objects.size
				yield* Effect.orDie(
					service.stage(
						id,
						yield* build([
							{ path: "a.txt", content: "a" },
							{ path: "c.txt", content: "crashed" },
						]),
						null,
					),
				)
				expect(store.objects.size).toBe(before + 2)
				const file = yield* call("GET", `/v1/artifacts/${id}/versions/1/file?file=a.txt`)
				expect((yield* json<FileBody>(file)).content).toBe("a")
				expect((yield* call("DELETE", `/v1/artifacts/${id}`)).status).toBe(200)
				expect(store.objects.size).toBe(0)
			}),
		))

	it("keeps the bytes of a version whose commit outcome is unknown", () =>
		withApi(({ call, callLostReply }) =>
			Effect.gen(function* () {
				const { id } = yield* json<ArtifactBody>(
					yield* call("POST", "/v1/artifacts", {
						name: "A",
						files: [{ path: "a.txt", content: "a" }],
					}),
				)
				const lost = yield* callLostReply(`/v1/artifacts/${id}/versions`, {
					version: 1,
					files: [{ path: "b.txt", content: "kept" }],
				})
				expect(lost.status).toBe(500)
				const file = yield* call("GET", `/v1/artifacts/${id}/versions/2/file?file=b.txt`)
				expect(file.status).toBe(200)
				expect((yield* json<FileBody>(file)).content).toBe("kept")
			}),
		))

	it("answers a resent version upload with the version it already committed", () =>
		withApi(({ call, callLostReply }) =>
			Effect.gen(function* () {
				const { id } = yield* json<ArtifactBody>(
					yield* call("POST", "/v1/artifacts", {
						name: "A",
						files: [{ path: "a.txt", content: "a" }],
					}),
				)
				const body = { version: 1, files: [{ path: "b.txt", content: "kept" }] }
				const lost = yield* callLostReply(`/v1/artifacts/${id}/versions`, body)
				expect(lost.status).toBe(500)
				const resent = yield* call("POST", `/v1/artifacts/${id}/versions`, body)
				expect(resent.status).toBe(201)
				expect((yield* json<VersionBody>(resent)).version).toBe(2)
				const head = yield* call("GET", `/v1/artifacts/${id}`)
				expect((yield* json<ArtifactBody>(head)).version).toBe(2)
			}),
		))

	it("refuses a resend whose files differ from the committed version", () =>
		withApi(({ call, callLostReply }) =>
			Effect.gen(function* () {
				const { id } = yield* json<ArtifactBody>(
					yield* call("POST", "/v1/artifacts", {
						name: "A",
						files: [{ path: "a.txt", content: "a" }],
					}),
				)
				const lost = yield* callLostReply(`/v1/artifacts/${id}/versions`, {
					version: 1,
					files: [{ path: "b.txt", content: "kept" }],
				})
				expect(lost.status).toBe(500)
				const resent = yield* call("POST", `/v1/artifacts/${id}/versions`, {
					version: 1,
					files: [{ path: "b.txt", content: "other" }],
				})
				expect(resent.status).toBe(409)
			}),
		))

	it("commits one version when the same upload arrives twice at once", () =>
		withApi(({ call }) =>
			Effect.gen(function* () {
				const { id } = yield* json<ArtifactBody>(
					yield* call("POST", "/v1/artifacts", {
						name: "A",
						files: [{ path: "a.txt", content: "a" }],
					}),
				)
				const body = { version: 1, files: [{ path: "b.txt", content: "kept" }] }
				const [first, second] = yield* Effect.all(
					[
						call("POST", `/v1/artifacts/${id}/versions`, body),
						call("POST", `/v1/artifacts/${id}/versions`, body),
					],
					{ concurrency: 2 },
				)
				expect(first.status).toBe(201)
				expect(second.status).toBe(201)
				expect((yield* json<VersionBody>(first)).version).toBe(2)
				expect((yield* json<VersionBody>(second)).version).toBe(2)
				const head = yield* call("GET", `/v1/artifacts/${id}`)
				expect((yield* json<ArtifactBody>(head)).version).toBe(2)
			}),
		))

	it("refuses a resend once a later version exists", () =>
		withApi(({ call, callLostReply }) =>
			Effect.gen(function* () {
				const { id } = yield* json<ArtifactBody>(
					yield* call("POST", "/v1/artifacts", {
						name: "A",
						files: [{ path: "a.txt", content: "a" }],
					}),
				)
				const body = { version: 1, files: [{ path: "b.txt", content: "kept" }] }
				const lost = yield* callLostReply(`/v1/artifacts/${id}/versions`, body)
				expect(lost.status).toBe(500)
				const next = yield* call("POST", `/v1/artifacts/${id}/versions`, {
					version: 2,
					files: [{ path: "c.txt", content: "c" }],
				})
				expect(next.status).toBe(201)
				const resent = yield* call("POST", `/v1/artifacts/${id}/versions`, body)
				expect(resent.status).toBe(409)
			}),
		))

	it("answers 404 and keeps no bytes when a delete lands between a version's upload and its commit", () =>
		withApi(({ call, store }) =>
			Effect.gen(function* () {
				const { id } = yield* json<ArtifactBody>(
					yield* call("POST", "/v1/artifacts", {
						name: "A",
						files: [{ path: "a.txt", content: "a" }],
					}),
				)
				store.setAfterStage(
					Effect.gen(function* () {
						store.setAfterStage(Effect.void)
						expect((yield* call("DELETE", `/v1/artifacts/${id}`)).status).toBe(200)
					}),
				)
				const added = yield* call("POST", `/v1/artifacts/${id}/versions`, {
					version: 1,
					files: [{ path: "b.txt", content: "late" }],
				})
				expect(added.status).toBe(404)
				expect([...store.objects.keys()]).toEqual([])
			}),
		))

	describe("creates and deletes whose request did not finish", () => {
		const files = [
			{ path: "a.txt", content: "a" },
			{ path: "b.txt", content: "b" },
		]

		it("releases the files of a create that never landed once its reservation expires", () =>
			withApi(({ callSteeredSend, steerSends, store, reservationsOf, expire }) =>
				Effect.gen(function* () {
					steerSends((command) => (command === "CreateArtifact" ? "lost" : "real"))
					expect((yield* callSteeredSend("/v1/artifacts", { name: "A", files })).status).toBe(500)
					const [id] = artifactIdsIn(store)
					const writeId = (yield* reservationsOf(id ?? "")).open
					expect(writeId).toBe(1)
					expect(store.objects.size).toBe(3)
					yield* expire(id ?? "", writeId)
					yield* eventually(
						Effect.sync(() => store.objects.size === 0),
						"the files are released",
					)
					expect((yield* reservationsOf(id ?? "")).open).toBe(0)
				}),
			))

		it("keeps a create that landed although its reply was lost", () =>
			withApi(({ call, callSteeredSend, steerSends, store, expire, reservationsOf }) =>
				Effect.gen(function* () {
					steerSends((command) => (command === "CreateArtifact" ? "landed" : "real"))
					expect((yield* callSteeredSend("/v1/artifacts", { name: "A", files })).status).toBe(500)
					const [id] = artifactIdsIn(store)
					yield* expire(id ?? "", (yield* reservationsOf(id ?? "")).made)
					const file = yield* call("GET", `/v1/artifacts/${id}/versions/1/file?file=b.txt`)
					expect((yield* json<FileBody>(file)).content).toBe("b")
					expect(store.objects.size).toBe(3)
				}),
			))

		it("refuses a create that stalls past its reservation, and a retry with the same key succeeds", () =>
			withApi(({ call, callSteeredSend, holdSend, store, reservationsOf, expire, statusForKey }) =>
				Effect.gen(function* () {
					const headers = { "idempotency-key": "stalled-then-retried" }
					const held = yield* holdSend("CreateArtifact")
					const stalled = yield* Effect.forkDetach(
						callSteeredSend("/v1/artifacts", { name: "A", files }, headers),
					)
					yield* held.reached
					const [id] = artifactIdsIn(store)
					yield* expire(id ?? "", (yield* reservationsOf(id ?? "")).open)
					yield* eventually(
						Effect.sync(() => store.objects.size === 0),
						"the files are released",
					)
					yield* held.release
					expect((yield* Fiber.join(stalled)).status).toBe(503)
					expect(yield* statusForKey("stalled-then-retried")).toBe("")
					const retried = yield* call("POST", "/v1/artifacts", { name: "A", files }, headers)
					expect(retried.status).toBe(201)
					expect(yield* statusForKey("stalled-then-retried")).toBe("active")
					const file = yield* call("GET", `/v1/artifacts/${id}/versions/1/file?file=a.txt`)
					expect((yield* json<FileBody>(file)).content).toBe("a")
				}),
			))

		it("keeps a retry's files when the reservation of an earlier attempt expires after it", () =>
			withApi(({ call, callSteeredSend, steerSends, store, reservationsOf, expire }) =>
				Effect.gen(function* () {
					const headers = { "idempotency-key": "expired-under-a-retry" }
					steerSends((command) => (command === "CreateArtifact" ? "lost" : "real"))
					expect(
						(yield* callSteeredSend("/v1/artifacts", { name: "A", files }, headers)).status,
					).toBe(500)
					const [id] = artifactIdsIn(store)
					const first = (yield* reservationsOf(id ?? "")).open
					expect((yield* call("POST", "/v1/artifacts", { name: "A", files }, headers)).status).toBe(
						201,
					)
					yield* expire(id ?? "", first)
					yield* Effect.sleep("50 millis")
					const file = yield* call("GET", `/v1/artifacts/${id}/versions/1/file?file=b.txt`)
					expect((yield* json<FileBody>(file)).content).toBe("b")
				}),
			))

		it("releases a failed create's files when a retry dies between its reservation and its upload", () =>
			withApi(({ call, callSteeredSend, steerSends, store, reservationsOf, expire }) =>
				Effect.gen(function* () {
					const headers = { "idempotency-key": "retry-died-before-upload" }
					steerSends((command) => (command === "CreateArtifact" ? "lost" : "real"))
					expect(
						(yield* callSteeredSend("/v1/artifacts", { name: "A", files }, headers)).status,
					).toBe(500)
					const [id] = artifactIdsIn(store)
					expect(store.objects.size).toBe(3)
					store.setBeforePut(
						Effect.suspend(() => {
							store.setBeforePut(Effect.void)
							return Effect.die(new Error("the retry died before its upload"))
						}),
					)
					expect((yield* call("POST", "/v1/artifacts", { name: "A", files }, headers)).status).toBe(
						500,
					)
					expect(yield* reservationsOf(id ?? "")).toEqual({ made: 2, open: 2 })
					yield* expire(id ?? "", 1)
					expect(store.objects.size).toBe(3)
					yield* expire(id ?? "", 2)
					yield* eventually(
						Effect.sync(() => store.objects.size === 0),
						"the files are released",
					)
				}),
			))

		it("uploads nothing when a keyed create's reservation is refused because the create already landed", () =>
			withApi(({ call, callSteeredSend, holdSend, store }) =>
				Effect.gen(function* () {
					const headers = { "idempotency-key": "reserve-lost-the-race" }
					const body = { name: "A", files }
					const held = yield* holdSend("ReserveArtifact")
					const slow = yield* Effect.forkDetach(callSteeredSend("/v1/artifacts", body, headers))
					yield* held.reached
					expect((yield* call("POST", "/v1/artifacts", body, headers)).status).toBe(201)
					const puts = [...store.objects.keys()].map((key) => store.putCount(key))
					yield* held.release
					expect((yield* Fiber.join(slow)).status).toBe(201)
					expect([...store.objects.keys()].map((key) => store.putCount(key))).toEqual(puts)
				}),
			))

		it("purges a deleted artifact's files although the delete request died after it committed", () =>
			withApi(({ call, deleteSteeredSend, steerSends, store }) =>
				Effect.gen(function* () {
					const { id } = yield* json<ArtifactBody>(
						yield* call("POST", "/v1/artifacts", { name: "A", files }),
					)
					expect(store.objects.size).toBe(3)
					steerSends((command) => (command === "DeleteArtifact" ? "landed" : "real"))
					expect((yield* deleteSteeredSend(`/v1/artifacts/${id}`)).status).toBe(500)
					yield* eventually(
						Effect.sync(() => store.objects.size === 0),
						"the files are purged",
					)
					expect((yield* call("GET", `/v1/artifacts/${id}`)).status).toBe(404)
				}),
			))

		it("refuses files staged into an artifact after its purge", () =>
			withApi(({ call, service, build, store }) =>
				Effect.gen(function* () {
					const { id } = yield* json<ArtifactBody>(
						yield* call("POST", "/v1/artifacts", { name: "A", files }),
					)
					expect((yield* call("DELETE", `/v1/artifacts/${id}`)).status).toBe(200)
					const late = yield* Effect.exit(service.stage(id, yield* build(files), null))
					expect(Exit.isFailure(late)).toBe(true)
					expect(store.objects.size).toBe(0)
				}),
			))
	})
})
