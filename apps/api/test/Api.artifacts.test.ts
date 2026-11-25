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
import { ArtifactView } from "@checkfu/domain/Artifact/ArtifactView.view"
import * as Digest from "effect/crypto/Digest"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import type { ArtifactFileInput, BuiltArtifactVersion } from "../src/Artifacts/ArtifactFiles.ts"
import { ARTIFACT_WRITE_GRACE_MS } from "../src/Artifacts/ArtifactOwnership.ts"
import {
	ARTIFACT_RECONCILE_PAGE,
	reconcileArtifactWrites,
} from "../src/Artifacts/ArtifactReconcile.ts"
import {
	ARTIFACT_DELETE_PREFIX,
	ArtifactStore,
	artifactBlobKey,
	artifactManifestKey,
	artifactMarkerKey,
	artifactPrefix,
	artifactReconcileCursorKey,
	deleteUntilEmpty,
	parseArtifactMarkerKey,
} from "../src/Artifacts/ArtifactStore.ts"
import type { ArtifactStoreService, ArtifactWriteCheck } from "../src/Artifacts/ArtifactStore.ts"
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
		readonly reconcile: Effect.Effect<void>
		readonly reconcileWithoutVersionRows: Effect.Effect<void>
		readonly reconcileBeforeFence: (run: Effect.Effect<void>) => Effect.Effect<void>
		readonly reconcileAfterListing: (run: Effect.Effect<void>) => Effect.Effect<void>
		readonly reconcileIn: (scope: string) => Effect.Effect<void>
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
			const heads = yield* ArtifactView
			let viewReads = 0
			const touched = () =>
				Effect.suspend(() => {
					viewReads += 1
					return Effect.die(new Error("a head read touched a view"))
				})
			const viewless = yield* makeApiHandler.pipe(
				Effect.provideService(ArtifactView, {
					...heads,
					get: touched,
					snapshot: touched,
					waitFor: touched,
					list: touched,
				}),
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
			const reconcileServices =
				yield* Effect.context<Effect.Services<typeof reconcileArtifactWrites>>()
			const reconcile = Effect.provide(reconcileArtifactWrites, reconcileServices)
			const reconcileBeforeFence = (run: Effect.Effect<void>) =>
				reconcileArtifactWrites.pipe(
					Effect.provideService(Artifact, {
						...aggregates,
						send: (command, options) =>
							command._tag === "FenceArtifactWrites"
								? Effect.andThen(run, aggregates.send(command, options))
								: aggregates.send(command, options),
					}),
					Effect.provide(reconcileServices),
				)
			const reconcileWithoutVersionRows = reconcileArtifactWrites.pipe(
				Effect.provideService(ArtifactVersionView, {
					...versionViews,
					get: () => Effect.succeedNone,
				}),
				Effect.provide(reconcileServices),
			)
			const reconcileIn = (scope: string) =>
				reconcileArtifactWrites.pipe(
					Effect.provide(artifactStore.layerIn(scope)),
					Effect.provide(reconcileServices),
				)
			const service = yield* ArtifactStore
			const reconcileAfterListing = (run: Effect.Effect<void>) =>
				reconcileArtifactWrites.pipe(
					Effect.provideService(ArtifactStore, {
						...service,
						unconfirmedWrites: (startAfter, limit) =>
							Effect.tap(service.unconfirmedWrites(startAfter, limit), () => run),
					}),
					Effect.provide(reconcileServices),
				)
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
				reconcile,
				reconcileWithoutVersionRows,
				reconcileBeforeFence,
				reconcileAfterListing,
				reconcileIn,
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
					yield* call("GET", `/v1/artifacts/${artifact.id}/versions/1/file?path=index.html`),
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
						`/v1/artifacts/${artifact.id}/versions/1/file?path=${encodeURIComponent("assets/logo.png")}`,
					),
				)
				expect(binary.encoding).toBe("base64")
				expect(binary.content).toBe(Base64.encode(PNG_BYTES))
				const second = yield* json<FileBody>(
					yield* call("GET", `/v1/artifacts/${artifact.id}/versions/2/file?path=index.html`),
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
					(yield* call("GET", `/v1/artifacts/${artifact.id}/versions/1/file?path=b.txt`)).status,
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
					yield* call("GET", `/v1/artifacts/${artifact.id}/versions/1/file?path=bom.txt`),
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
					(yield* callViewless("GET", `/v1/artifacts/${artifact.id}/versions/2/file?path=c.txt`))
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

	it("removes the partial upload of a create that storage refused part-way", () =>
		withApi(({ call, store }) =>
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
				expect([...store.objects.keys()]).toEqual([])
				store.setFailManifest(false)
				const [ledger, ...others] = store.ledgers.values()
				expect(others).toEqual([])
				expect(ledger?.isEmpty()).toBe(false)
				store.advanceClock(ARTIFACT_WRITE_GRACE_MS)
				yield* store.runDueAlarms
				expect(ledger?.isEmpty()).toBe(true)
				expect([...store.alarms.keys()]).toEqual([])
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
					(yield* call("GET", `/v1/artifacts/${artifact.id}/versions/1/file?path=a.txt`)).status,
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

	it("keeps the files, deletes, and reconciliation of each jurisdiction apart", () =>
		withApi(({ call, store, build, reconcile, reconcileIn, serviceIn }) =>
			Effect.gen(function* () {
				const files = [{ path: "a.txt", content: "a" }]
				const { id } = yield* json<ArtifactBody>(
					yield* call("POST", "/v1/artifacts", { name: "A", files }),
				)
				const eu = yield* serviceIn("eu")
				const built = yield* build(files)
				yield* Effect.orDie(eu.putVersion(id, built))
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

				const markerIn = (scope: string, writeId: string) => {
					const key = artifactMarkerKey(scope, id, writeId)
					store.upload(
						key,
						JSON.stringify({
							artifact_id: id,
							write_id: writeId,
							check: { kind: "create", manifest: built.manifest_hash },
						}),
					)
					return key
				}
				markerIn(SCOPE, "w_here")
				const there = markerIn("eu", "w_there")
				store.advanceClock(ARTIFACT_WRITE_GRACE_MS)
				yield* reconcile
				expect(store.markers()).toEqual([there])
				yield* reconcileIn("eu")
				expect(store.markers()).toEqual([])
				expect(keysIn("eu")).toEqual(euKeys)
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
					(yield* call("GET", `/v1/artifacts/${artifact.id}/versions/1/file?path=a.txt`)).status,
				).toBe(200)
			}),
		))

	it("keeps the winner's bytes and reclaims the loser's when two writers race for a version", () =>
		withApi(({ call, store, build }) =>
			Effect.gen(function* () {
				const shared = { path: "shared.txt", content: "shared" }
				const { id } = yield* json<ArtifactBody>(
					yield* call("POST", "/v1/artifacts", {
						name: "A",
						files: [shared, { path: "one.txt", content: "one" }],
					}),
				)
				const before = [...store.objects.keys()]
				const winnerFiles = [shared, { path: "b.txt", content: "winner" }]
				const loserFiles = [shared, { path: "a.txt", content: "loser" }]
				let winner: Response | undefined
				store.setBeforePut(
					Effect.gen(function* () {
						store.setBeforePut(Effect.void)
						winner = yield* call("POST", `/v1/artifacts/${id}/versions`, {
							version: 1,
							files: winnerFiles,
						})
					}),
				)
				const loser = yield* call("POST", `/v1/artifacts/${id}/versions`, {
					version: 1,
					files: loserFiles,
				})
				expect(winner?.status).toBe(201)
				expect(loser.status).toBe(409)

				const won = yield* build(winnerFiles)
				const lost = yield* build(loserFiles)
				const loserOnly = lost.blobs.find(
					(blob) => !won.blobs.some((kept) => kept.sha256 === blob.sha256),
				)
				expect([...store.objects.keys()].sort()).toEqual(
					[
						...before,
						artifactManifestKey(SCOPE, id, won.manifest_hash),
						...won.blobs
							.map((blob) => artifactBlobKey(SCOPE, id, blob.sha256))
							.filter((key) => !before.includes(key)),
					].sort(),
				)
				expect(store.objects.has(artifactManifestKey(SCOPE, id, lost.manifest_hash))).toBe(false)
				expect(store.objects.has(artifactBlobKey(SCOPE, id, loserOnly?.sha256 ?? ""))).toBe(false)

				const read = (version: number, path: string) =>
					Effect.flatMap(
						call("GET", `/v1/artifacts/${id}/versions/${version}/file?path=${path}`),
						json<FileBody>,
					)
				expect((yield* read(1, "shared.txt")).content).toBe("shared")
				expect((yield* read(1, "one.txt")).content).toBe("one")
				expect((yield* read(2, "shared.txt")).content).toBe("shared")
				expect((yield* read(2, "b.txt")).content).toBe("winner")
			}),
		))

	it("leaves no new bytes behind when a version's upload fails part-way", () =>
		withApi(({ call, store }) =>
			Effect.gen(function* () {
				const { id } = yield* json<ArtifactBody>(
					yield* call("POST", "/v1/artifacts", {
						name: "A",
						files: [{ path: "a.txt", content: "a" }],
					}),
				)
				const before = [...store.objects.keys()].sort()
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
				expect([...store.objects.keys()].sort()).toEqual(before)
				const file = yield* call("GET", `/v1/artifacts/${id}/versions/1/file?path=a.txt`)
				expect((yield* json<FileBody>(file)).content).toBe("a")
			}),
		))

	it("reclaims a failed keyed create without deleting what a concurrent replay of the key needs", () =>
		withApi(({ call, store, statusForKey }) =>
			Effect.gen(function* () {
				const body = {
					name: "A",
					files: [
						{ path: "a.txt", content: "a" },
						{ path: "b.txt", content: "b" },
					],
				}
				store.setFailManifest(true)
				const partial = yield* call("POST", "/v1/artifacts", body, { "idempotency-key": "partial" })
				expect(partial.status).toBe(503)
				expect([...store.objects.keys()]).toEqual([])
				expect(yield* statusForKey("partial")).toBe("")

				const headers = { "idempotency-key": "replayed" }
				const staged = yield* Deferred.make<void>()
				let replay: Fiber.Fiber<Response> | undefined
				store.setBeforeDelete(
					Effect.gen(function* () {
						store.setBeforeDelete(Effect.void)
						store.setFailManifest(false)
						store.setAfterStage(
							Effect.andThen(
								Deferred.succeed(staged, undefined),
								Effect.sync(() => store.setAfterStage(Effect.void)),
							),
						)
						replay = yield* Effect.forkDetach(call("POST", "/v1/artifacts", body, headers))
						yield* Deferred.await(staged).pipe(Effect.timeout("200 millis"), Effect.ignore)
					}),
				)
				const failed = yield* call("POST", "/v1/artifacts", body, headers)
				expect(failed.status).toBe(503)
				expect(replay).toBeDefined()
				const replayed = yield* Fiber.join(replay ?? (yield* Effect.die("no replay")))
				expect(replayed.status).toBe(201)
				const { id } = yield* json<ArtifactBody>(replayed)
				for (const file of body.files) {
					const read = yield* call("GET", `/v1/artifacts/${id}/versions/1/file?path=${file.path}`)
					expect(read.status).toBe(200)
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

	it("reclaims a write that was staged and never committed once the grace period passes", () =>
		withApi(({ call, store, service, build }) =>
			Effect.gen(function* () {
				const { id } = yield* json<ArtifactBody>(
					yield* call("POST", "/v1/artifacts", {
						name: "A",
						files: [{ path: "a.txt", content: "a" }],
					}),
				)
				const before = [...store.objects.keys()].sort()
				const crashed = yield* Effect.orDie(
					service.stage(
						id,
						yield* build([
							{ path: "a.txt", content: "a" },
							{ path: "c.txt", content: "crashed" },
						]),
					),
				)
				expect(store.objects.size).toBe(before.length + 2)
				store.advanceClock(ARTIFACT_WRITE_GRACE_MS - 1)
				yield* store.runDueAlarms
				expect(store.objects.size).toBe(before.length + 2)
				store.advanceClock(1)
				yield* store.runDueAlarms
				expect([...store.objects.keys()].sort()).toEqual(before)
				expect(Exit.isFailure(yield* Effect.exit(crashed.markCommitted(null)))).toBe(true)
				const file = yield* call("GET", `/v1/artifacts/${id}/versions/1/file?path=a.txt`)
				expect((yield* json<FileBody>(file)).content).toBe("a")

				store.setAfterStage(
					Effect.sync(() => {
						store.setAfterStage(Effect.void)
						store.advanceClock(ARTIFACT_WRITE_GRACE_MS)
					}),
				)
				const late = yield* call("POST", `/v1/artifacts/${id}/versions`, {
					version: 1,
					files: [{ path: "a.txt", content: "late" }],
				})
				expect(late.status).toBe(503)
				expect((yield* json<ArtifactBody>(yield* call("GET", `/v1/artifacts/${id}`))).version).toBe(
					1,
				)
				yield* store.runDueAlarms
				expect([...store.objects.keys()].sort()).toEqual(before)
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
				const file = yield* call("GET", `/v1/artifacts/${id}/versions/2/file?path=b.txt`)
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

	describe("writes whose command outcome was never learned", () => {
		const files = [
			{ path: "a.txt", content: "a" },
			{ path: "b.txt", content: "b" },
		]
		const artifactOf = (markers: ReadonlyArray<string>) =>
			parseArtifactMarkerKey(SCOPE, markers[0] ?? "")?.artifact_id ?? ""

		it("leaves no marker after a create and a version that succeed", () =>
			withApi(({ call, store }) =>
				Effect.gen(function* () {
					const { id } = yield* json<ArtifactBody>(
						yield* call("POST", "/v1/artifacts", { name: "A", files }),
					)
					expect(
						(yield* call("POST", `/v1/artifacts/${id}/versions`, {
							version: 1,
							files: [{ path: "c.txt", content: "c" }],
						})).status,
					).toBe(201)
					expect(store.markers()).toEqual([])
				}),
			))

		it("reclaims an unkeyed create that never landed, but only after the grace period", () =>
			withApi(({ store, steerSends, sentCommandIds, callSteeredSend, reconcile }) =>
				Effect.gen(function* () {
					steerSends((command) => (command === "CreateArtifact" ? "lost" : "real"))
					expect((yield* callSteeredSend("/v1/artifacts", { name: "A", files })).status).toBe(500)
					expect(sentCommandIds[0]).toMatch(/^create-artifact:/u)
					const stored = [...store.objects.keys()].sort()
					expect(stored).toHaveLength(4)
					expect(store.markers()).toHaveLength(1)

					store.advanceClock(ARTIFACT_WRITE_GRACE_MS - 1)
					yield* reconcile
					expect([...store.objects.keys()].sort()).toEqual(stored)

					store.advanceClock(1)
					yield* reconcile
					expect([...store.objects.keys()]).toEqual([])
				}),
			))

		it("keeps an unkeyed create that landed although its reply was lost", () =>
			withApi(({ call, store, steerSends, callSteeredSend, reconcile }) =>
				Effect.gen(function* () {
					steerSends((command) => (command === "CreateArtifact" ? "landed" : "real"))
					expect((yield* callSteeredSend("/v1/artifacts", { name: "A", files })).status).toBe(500)
					const id = artifactOf(store.markers())
					store.advanceClock(ARTIFACT_WRITE_GRACE_MS)
					yield* reconcile
					expect(store.markers()).toEqual([])
					for (const file of files) {
						const read = yield* call("GET", `/v1/artifacts/${id}/versions/1/file?path=${file.path}`)
						expect((yield* json<FileBody>(read)).content).toBe(file.content)
					}
				}),
			))

		it("reclaims a version that never landed and keeps one that did", () =>
			withApi(({ call, store, steerSends, callSteeredSend, reconcile }) =>
				Effect.gen(function* () {
					const { id } = yield* json<ArtifactBody>(
						yield* call("POST", "/v1/artifacts", { name: "A", files }),
					)
					const before = [...store.objects.keys()].sort()
					const addVersion = (content: string) =>
						callSteeredSend(`/v1/artifacts/${id}/versions`, {
							version: 1,
							files: [files[0], { path: "c.txt", content }],
						})
					steerSends((command) => (command === "AddArtifactVersion" ? "lost" : "real"))
					expect((yield* addVersion("lost")).status).toBe(500)
					store.advanceClock(ARTIFACT_WRITE_GRACE_MS)
					yield* reconcile
					expect([...store.objects.keys()].sort()).toEqual(before)
					const first = yield* call("GET", `/v1/artifacts/${id}/versions/1/file?path=b.txt`)
					expect((yield* json<FileBody>(first)).content).toBe("b")

					steerSends((command) => (command === "AddArtifactVersion" ? "landed" : "real"))
					expect((yield* addVersion("landed")).status).toBe(500)
					store.advanceClock(ARTIFACT_WRITE_GRACE_MS)
					yield* reconcile
					expect(store.markers()).toEqual([])
					const second = yield* call("GET", `/v1/artifacts/${id}/versions/2/file?path=c.txt`)
					expect((yield* json<FileBody>(second)).content).toBe("landed")
				}),
			))

		it("keeps a keyed create whose replay succeeded before reconciliation", () =>
			withApi(({ call, store, steerSends, callSteeredSend, reconcile }) =>
				Effect.gen(function* () {
					const headers = { "idempotency-key": "lost-then-replayed" }
					steerSends((command) => (command === "CreateArtifact" ? "lost" : "real"))
					expect(
						(yield* callSteeredSend("/v1/artifacts", { name: "A", files }, headers)).status,
					).toBe(500)
					const replayed = yield* call("POST", "/v1/artifacts", { name: "A", files }, headers)
					expect(replayed.status).toBe(201)
					const { id } = yield* json<ArtifactBody>(replayed)
					store.advanceClock(ARTIFACT_WRITE_GRACE_MS)
					yield* reconcile
					expect(store.markers()).toEqual([])
					for (const file of files) {
						const read = yield* call("GET", `/v1/artifacts/${id}/versions/1/file?path=${file.path}`)
						expect((yield* json<FileBody>(read)).content).toBe(file.content)
					}
				}),
			))

		it("keeps a landed version that later versions overtook before reconciliation", () =>
			withApi(({ call, store, steerSends, callSteeredSend, reconcile }) =>
				Effect.gen(function* () {
					const { id } = yield* json<ArtifactBody>(
						yield* call("POST", "/v1/artifacts", { name: "A", files }),
					)
					steerSends((command) => (command === "AddArtifactVersion" ? "landed" : "real"))
					expect(
						(yield* callSteeredSend(`/v1/artifacts/${id}/versions`, {
							version: 1,
							files: [{ path: "c.txt", content: "landed" }],
						})).status,
					).toBe(500)
					for (const version of [2, 3]) {
						const added = yield* call("POST", `/v1/artifacts/${id}/versions`, {
							version,
							files: [{ path: `v${version + 1}.txt`, content: String(version + 1) }],
						})
						expect(added.status).toBe(201)
					}
					store.advanceClock(ARTIFACT_WRITE_GRACE_MS)
					yield* reconcile
					expect(store.markers()).toEqual([])
					const kept = yield* call("GET", `/v1/artifacts/${id}/versions/2/file?path=c.txt`)
					expect(kept.status).toBe(200)
					expect((yield* json<FileBody>(kept)).content).toBe("landed")
				}),
			))

		it("keeps a landed keyed create that a later version overtook before reconciliation", () =>
			withApi(({ call, store, steerSends, callSteeredSend, reconcile }) =>
				Effect.gen(function* () {
					const headers = { "idempotency-key": "landed-then-overtaken" }
					steerSends((command) => (command === "CreateArtifact" ? "landed" : "real"))
					expect(
						(yield* callSteeredSend("/v1/artifacts", { name: "A", files }, headers)).status,
					).toBe(500)
					const id = artifactOf(store.markers())
					const added = yield* call("POST", `/v1/artifacts/${id}/versions`, {
						version: 1,
						files: [{ path: "z.txt", content: "z" }],
					})
					expect(added.status).toBe(201)
					store.advanceClock(ARTIFACT_WRITE_GRACE_MS)
					yield* reconcile
					expect(store.markers()).toEqual([])
					for (const file of files) {
						const read = yield* call("GET", `/v1/artifacts/${id}/versions/1/file?path=${file.path}`)
						expect(read.status).toBe(200)
						expect((yield* json<FileBody>(read)).content).toBe(file.content)
					}
				}),
			))

		it("waits on an overtaken write while its version row is missing, then settles it", () =>
			withApi(
				({ call, store, steerSends, callSteeredSend, reconcile, reconcileWithoutVersionRows }) =>
					Effect.gen(function* () {
						const { id } = yield* json<ArtifactBody>(
							yield* call("POST", "/v1/artifacts", { name: "A", files }),
						)
						steerSends((command) => (command === "AddArtifactVersion" ? "landed" : "real"))
						expect(
							(yield* callSteeredSend(`/v1/artifacts/${id}/versions`, {
								version: 1,
								files: [{ path: "c.txt", content: "landed" }],
							})).status,
						).toBe(500)
						const added = yield* call("POST", `/v1/artifacts/${id}/versions`, {
							version: 2,
							files: [{ path: "d.txt", content: "d" }],
						})
						expect(added.status).toBe(201)
						const stored = [...store.objects.keys()].sort()
						const markers = store.markers()
						expect(markers).toHaveLength(1)
						store.advanceClock(ARTIFACT_WRITE_GRACE_MS)
						yield* reconcileWithoutVersionRows
						expect([...store.objects.keys()].sort()).toEqual(stored)
						expect(store.markers()).toEqual(markers)
						yield* reconcile
						expect(store.markers()).toEqual([])
						const kept = yield* call("GET", `/v1/artifacts/${id}/versions/2/file?path=c.txt`)
						expect((yield* json<FileBody>(kept)).content).toBe("landed")
					}),
			))
	})

	describe("writes whose command stalls past reconciliation", () => {
		const files = [
			{ path: "a.txt", content: "a" },
			{ path: "b.txt", content: "b" },
		]
		const INTERRUPTED = "The write was interrupted; retry the request."
		const markedArtifact = (markers: ReadonlyArray<string>) =>
			parseArtifactMarkerKey(SCOPE, markers[0] ?? "")?.artifact_id ?? ""

		const everyFileReadable = (
			call: (method: string, path: string) => Effect.Effect<Response>,
			id: string,
		) =>
			Effect.gen(function* () {
				const head = yield* json<ArtifactBody>(yield* call("GET", `/v1/artifacts/${id}`))
				for (let version = 1; version <= head.version; version++) {
					const found = yield* json<VersionBody>(
						yield* call("GET", `/v1/artifacts/${id}/versions/${version}`),
					)
					for (const file of found.files) {
						const read = yield* call(
							"GET",
							`/v1/artifacts/${id}/versions/${version}/file?path=${file.path}`,
						)
						expect(read.status, `${version} ${file.path}`).toBe(200)
					}
				}
				return head.version
			})

		it("fences a stalled create, reclaims its files, and refuses the create when it resumes", () =>
			withApi(({ call, store, holdSend, callSteeredSend, reconcile }) =>
				Effect.gen(function* () {
					const gate = yield* holdSend("CreateArtifact")
					const stalled = yield* Effect.forkChild(
						callSteeredSend("/v1/artifacts", { name: "A", files }),
					)
					yield* gate.reached
					const id = markedArtifact(store.markers())
					store.advanceClock(ARTIFACT_WRITE_GRACE_MS)
					yield* reconcile
					expect(store.markers()).toEqual([])
					expect(
						[...store.objects.keys()].filter((key) => key.startsWith(artifactPrefix(SCOPE, id))),
					).toEqual([])
					yield* gate.release
					const refused = yield* Fiber.join(stalled)
					expect(refused.status).toBe(503)
					expect((yield* json<ErrorBody>(refused)).error.message).toBe(INTERRUPTED)
					expect((yield* call("GET", `/v1/artifacts/${id}`)).status).toBe(404)
					expect(
						[...store.objects.keys()].filter((key) => key.startsWith(artifactPrefix(SCOPE, id))),
					).toEqual([])
				}),
			))

		it("fences a stalled version, reclaims its files, and refuses the version when it resumes", () =>
			withApi(({ call, store, holdSend, callSteeredSend, reconcile }) =>
				Effect.gen(function* () {
					const { id } = yield* json<ArtifactBody>(
						yield* call("POST", "/v1/artifacts", { name: "A", files }),
					)
					const before = [...store.objects.keys()].sort()
					const gate = yield* holdSend("AddArtifactVersion")
					const stalled = yield* Effect.forkChild(
						callSteeredSend(`/v1/artifacts/${id}/versions`, {
							version: 1,
							files: [{ path: "c.txt", content: "stalled" }],
						}),
					)
					yield* gate.reached
					expect(store.markers()).toHaveLength(1)
					store.advanceClock(ARTIFACT_WRITE_GRACE_MS)
					yield* reconcile
					expect(store.markers()).toEqual([])
					expect([...store.objects.keys()].sort()).toEqual(before)
					yield* gate.release
					const refused = yield* Fiber.join(stalled)
					expect(refused.status).toBe(503)
					expect((yield* json<ErrorBody>(refused)).error.message).toBe(INTERRUPTED)
					expect([...store.objects.keys()].sort()).toEqual(before)
					expect((yield* call("GET", `/v1/artifacts/${id}/versions/2`)).status).toBe(404)
					expect(yield* everyFileReadable(call, id)).toBe(1)
					const retried = yield* call("POST", `/v1/artifacts/${id}/versions`, {
						version: 1,
						files: [{ path: "c.txt", content: "retried" }],
					})
					expect(retried.status).toBe(201)
					expect(yield* everyFileReadable(call, id)).toBe(2)
				}),
			))

		it("confirms a create that lands between reconciliation's first read and its fence", () =>
			withApi(({ call, store, holdSend, steerSends, callSteeredSend, reconcileBeforeFence }) =>
				Effect.gen(function* () {
					steerSends((command) => (command === "CreateArtifact" ? "landed" : "real"))
					const gate = yield* holdSend("CreateArtifact")
					const stalled = yield* Effect.forkChild(
						callSteeredSend("/v1/artifacts", { name: "A", files }),
					)
					yield* gate.reached
					const id = markedArtifact(store.markers())
					const stored = [...store.objects.keys()].filter((key) => key.startsWith("artifacts/"))
					store.advanceClock(ARTIFACT_WRITE_GRACE_MS)
					yield* reconcileBeforeFence(
						Effect.gen(function* () {
							yield* gate.release
							expect((yield* Fiber.join(stalled)).status).toBe(500)
						}),
					)
					expect(store.markers()).toEqual([])
					expect([...store.objects.keys()].filter((key) => key.startsWith("artifacts/"))).toEqual(
						stored,
					)
					expect(yield* everyFileReadable(call, id)).toBe(1)
				}),
			))

		it("lets a keyed create whose first attempt was fenced succeed on retry with the same key", () =>
			withApi(({ call, store, holdSend, callSteeredSend, reconcile, statusForKey }) =>
				Effect.gen(function* () {
					const headers = { "idempotency-key": "fenced-then-retried" }
					const gate = yield* holdSend("CreateArtifact")
					const stalled = yield* Effect.forkChild(
						callSteeredSend("/v1/artifacts", { name: "A", files }, headers),
					)
					yield* gate.reached
					store.advanceClock(ARTIFACT_WRITE_GRACE_MS)
					yield* reconcile
					yield* gate.release
					expect((yield* Fiber.join(stalled)).status).toBe(503)
					expect(yield* statusForKey("fenced-then-retried")).toBe("")
					const retried = yield* call("POST", "/v1/artifacts", { name: "A", files }, headers)
					expect(retried.status).toBe(201)
					const { id } = yield* json<ArtifactBody>(retried)
					expect(yield* statusForKey("fenced-then-retried")).toBe("active")
					expect(yield* everyFileReadable(call, id)).toBe(1)
					expect(store.markers()).toEqual([])
				}),
			))

		it("abandons a write whose version another write took, without refusing a live upload", () =>
			withApi(({ call, store, steerSends, callSteeredSend, reconcile, build }) =>
				Effect.gen(function* () {
					const { id } = yield* json<ArtifactBody>(
						yield* call("POST", "/v1/artifacts", { name: "A", files }),
					)
					steerSends((command) => (command === "AddArtifactVersion" ? "lost" : "real"))
					const lostFiles = [{ path: "lost.txt", content: "lost" }]
					const lost = yield* callSteeredSend(`/v1/artifacts/${id}/versions`, {
						version: 1,
						files: lostFiles,
					})
					expect(lost.status).toBe(500)
					steerSends(() => "real")
					const won = yield* call("POST", `/v1/artifacts/${id}/versions`, {
						version: 1,
						files: [{ path: "won.txt", content: "won" }],
					})
					expect(won.status).toBe(201)
					store.advanceClock(ARTIFACT_WRITE_GRACE_MS)
					store.setAfterStage(
						Effect.andThen(
							Effect.sync(() => store.setAfterStage(Effect.void)),
							reconcile,
						),
					)
					const live = yield* call("POST", `/v1/artifacts/${id}/versions`, {
						version: 2,
						files: [{ path: "live.txt", content: "live" }],
					})
					expect(live.status).toBe(201)
					expect(store.markers()).toEqual([])
					const [blob] = (yield* build(lostFiles)).blobs
					expect(store.objects.has(artifactBlobKey(SCOPE, id, blob?.sha256 ?? ""))).toBe(false)
					expect(yield* everyFileReadable(call, id)).toBe(3)
				}),
			))

		it("refuses a live writer whose fence a reconciliation moved, reclaims its files, and lets it retry", () =>
			withApi(({ call, store, steerSends, callSteeredSend, reconcile, build }) =>
				Effect.gen(function* () {
					const { id } = yield* json<ArtifactBody>(
						yield* call("POST", "/v1/artifacts", { name: "A", files }),
					)
					const before = [...store.objects.keys()].filter((key) => key.startsWith("artifacts/"))
					steerSends((command) => (command === "AddArtifactVersion" ? "lost" : "real"))
					const lost = yield* callSteeredSend(`/v1/artifacts/${id}/versions`, {
						version: 1,
						files: [{ path: "lost.txt", content: "lost" }],
					})
					expect(lost.status).toBe(500)
					steerSends(() => "real")
					store.advanceClock(ARTIFACT_WRITE_GRACE_MS)
					const live = [{ path: "live.txt", content: "live" }]
					store.setAfterStage(
						Effect.andThen(
							Effect.sync(() => store.setAfterStage(Effect.void)),
							reconcile,
						),
					)
					const refused = yield* call("POST", `/v1/artifacts/${id}/versions`, {
						version: 1,
						files: live,
					})
					expect(refused.status).toBe(503)
					expect((yield* json<ErrorBody>(refused)).error.message).toBe(INTERRUPTED)
					const [blob] = (yield* build(live)).blobs
					expect(store.objects.has(artifactBlobKey(SCOPE, id, blob?.sha256 ?? ""))).toBe(false)
					expect(
						[...store.objects.keys()].filter((key) => key.startsWith("artifacts/")).sort(),
					).toEqual(before.sort())
					expect(store.markers()).toEqual([])
					const retried = yield* call("POST", `/v1/artifacts/${id}/versions`, {
						version: 1,
						files: live,
					})
					expect(retried.status).toBe(201)
					expect(yield* everyFileReadable(call, id)).toBe(2)
				}),
			))
	})

	describe("deletes whose purge did not finish", () => {
		const files = [{ path: "a.txt", content: "a" }]
		const ownedBy = (store: { readonly objects: Map<string, Uint8Array> }, id: string) =>
			[...store.objects.keys()].filter((key) => key.startsWith(artifactPrefix(SCOPE, id)))
		const INTERRUPTED = "The write was interrupted; retry the request."

		it("purges a deleted artifact's files once the grace passes, retrying a purge that fails", () =>
			withApi(({ call, store, reconcile }) =>
				Effect.gen(function* () {
					const { id } = yield* json<ArtifactBody>(
						yield* call("POST", "/v1/artifacts", { name: "A", files }),
					)
					store.setFailing(true)
					expect((yield* call("DELETE", `/v1/artifacts/${id}`)).status).toBe(503)
					store.setFailing(false)
					expect((yield* call("GET", `/v1/artifacts/${id}`)).status).toBe(200)

					store.setBeforeDelete(Effect.sync(() => store.setFailing(true)))
					expect((yield* call("DELETE", `/v1/artifacts/${id}`)).status).toBe(503)
					store.setBeforeDelete(Effect.void)
					store.setFailing(false)
					expect((yield* call("GET", `/v1/artifacts/${id}`)).status).toBe(404)
					expect(ownedBy(store, id)).toHaveLength(2)
					expect(
						store.markers().map((key) => parseArtifactMarkerKey(SCOPE, key)?.write_id.slice(0, 7)),
					).toEqual([ARTIFACT_DELETE_PREFIX])

					store.advanceClock(ARTIFACT_WRITE_GRACE_MS - 1)
					yield* reconcile
					expect(ownedBy(store, id)).toHaveLength(2)

					store.advanceClock(1)
					store.setBeforeDelete(Effect.sync(() => store.setFailing(true)))
					yield* reconcile
					store.setBeforeDelete(Effect.void)
					store.setFailing(false)
					expect(ownedBy(store, id)).toHaveLength(2)
					expect(store.markers()).toHaveLength(1)

					yield* reconcile
					expect(ownedBy(store, id)).toEqual([])
					expect(store.markers()).toEqual([])
					expect(store.ledgers.get(artifactPrefix(SCOPE, id))?.isEmpty()).toBe(true)
				}),
			))

		it("fences off a delete whose request died before its command, and removes its marker", () =>
			withApi(({ call, store, steerSends, deleteSteeredSend, reconcile }) =>
				Effect.gen(function* () {
					const { id } = yield* json<ArtifactBody>(
						yield* call("POST", "/v1/artifacts", { name: "A", files }),
					)
					const kept = ownedBy(store, id)
					steerSends((command) => (command === "DeleteArtifact" ? "lost" : "real"))
					expect((yield* deleteSteeredSend(`/v1/artifacts/${id}`)).status).toBe(500)
					steerSends(() => "real")
					const dead = store.markers()
					expect(dead).toHaveLength(1)

					store.advanceClock(ARTIFACT_WRITE_GRACE_MS - 1)
					yield* reconcile
					expect(store.markers()).toEqual(dead)

					store.advanceClock(1)
					yield* reconcile
					expect(store.markers()).toEqual([])
					expect(ownedBy(store, id)).toEqual(kept)
					const file = yield* call("GET", `/v1/artifacts/${id}/versions/1/file?path=a.txt`)
					expect((yield* json<FileBody>(file)).content).toBe("a")

					expect((yield* call("DELETE", `/v1/artifacts/${id}`)).status).toBe(200)
					expect(ownedBy(store, id)).toEqual([])
					expect(store.markers()).toEqual([])
				}),
			))

		it("refuses a delete that stalls past a reconciliation's fence and keeps the artifact", () =>
			withApi(({ call, store, holdSend, deleteSteeredSend, reconcile }) =>
				Effect.gen(function* () {
					const { id } = yield* json<ArtifactBody>(
						yield* call("POST", "/v1/artifacts", { name: "A", files }),
					)
					const kept = ownedBy(store, id)
					const gate = yield* holdSend("DeleteArtifact")
					const stalled = yield* Effect.forkDetach(deleteSteeredSend(`/v1/artifacts/${id}`))
					yield* gate.reached
					expect(store.markers()).toHaveLength(1)
					store.advanceClock(ARTIFACT_WRITE_GRACE_MS)
					yield* reconcile
					expect(store.markers()).toEqual([])

					yield* gate.release
					const refused = yield* Fiber.join(stalled)
					expect(refused.status).toBe(503)
					expect((yield* json<ErrorBody>(refused)).error.message).toBe(INTERRUPTED)
					expect((yield* call("GET", `/v1/artifacts/${id}`)).status).toBe(200)
					expect(ownedBy(store, id)).toEqual(kept)
					expect(store.markers()).toEqual([])
				}),
			))

		it("refuses a retry that read the fence before a reconciliation moved it, then deletes on the next", () =>
			withApi(({ call, store, steerSends, deleteSteeredSend, holdSend, reconcileAfterListing }) =>
				Effect.gen(function* () {
					const { id } = yield* json<ArtifactBody>(
						yield* call("POST", "/v1/artifacts", { name: "A", files }),
					)
					steerSends((command) => (command === "DeleteArtifact" ? "lost" : "real"))
					expect((yield* deleteSteeredSend(`/v1/artifacts/${id}`)).status).toBe(500)
					steerSends(() => "real")
					const dead = store.markers()
					store.advanceClock(ARTIFACT_WRITE_GRACE_MS)

					const gate = yield* holdSend("DeleteArtifact")
					let retry: Fiber.Fiber<Response> | undefined
					yield* reconcileAfterListing(
						Effect.gen(function* () {
							retry = yield* Effect.forkDetach(deleteSteeredSend(`/v1/artifacts/${id}`))
							yield* gate.reached
						}),
					)
					const fresh = store.markers()
					expect(fresh).toHaveLength(1)
					expect(fresh).not.toEqual(dead)

					yield* gate.release
					const refused = yield* Fiber.join(retry ?? (yield* Effect.die("no retry")))
					expect(refused.status).toBe(503)
					expect((yield* json<ErrorBody>(refused)).error.message).toBe(INTERRUPTED)
					expect(ownedBy(store, id)).toHaveLength(2)

					expect((yield* call("DELETE", `/v1/artifacts/${id}`)).status).toBe(200)
					expect(ownedBy(store, id)).toEqual([])
					expect(store.markers()).toEqual([])
				}),
			))

		it("purges a delete that lands between reconciliation's first read and its fence", () =>
			withApi(({ call, store, holdSend, deleteSteeredSend, reconcileBeforeFence }) =>
				Effect.gen(function* () {
					const { id } = yield* json<ArtifactBody>(
						yield* call("POST", "/v1/artifacts", { name: "A", files }),
					)
					const gate = yield* holdSend("DeleteArtifact")
					const stalled = yield* Effect.forkDetach(deleteSteeredSend(`/v1/artifacts/${id}`))
					yield* gate.reached
					store.advanceClock(ARTIFACT_WRITE_GRACE_MS)
					store.setBeforeDelete(Effect.sync(() => store.setFailing(true)))
					yield* reconcileBeforeFence(
						Effect.gen(function* () {
							yield* gate.release
							expect((yield* Fiber.join(stalled)).status).toBe(503)
							store.setBeforeDelete(Effect.void)
							store.setFailing(false)
							expect((yield* call("GET", `/v1/artifacts/${id}`)).status).toBe(404)
							expect(ownedBy(store, id)).toHaveLength(2)
						}),
					)
					expect(ownedBy(store, id)).toEqual([])
					expect(store.markers()).toEqual([])
				}),
			))

		it("removes the marker of a delete that never landed and keeps one whose artifact is unknown", () =>
			withApi(({ call, store, reconcile }) =>
				Effect.gen(function* () {
					const { id } = yield* json<ArtifactBody>(
						yield* call("POST", "/v1/artifacts", { name: "A", files }),
					)
					const kept = ownedBy(store, id)
					const unknown = artifactMarkerKey(SCOPE, "art_unknown", `${ARTIFACT_DELETE_PREFIX}a`)
					store.upload(artifactMarkerKey(SCOPE, id, `${ARTIFACT_DELETE_PREFIX}b`), "")
					store.upload(unknown, "")
					store.advanceClock(ARTIFACT_WRITE_GRACE_MS)
					yield* reconcile
					expect(store.markers()).toEqual([unknown])
					expect(ownedBy(store, id)).toEqual(kept)
					const file = yield* call("GET", `/v1/artifacts/${id}/versions/1/file?path=a.txt`)
					expect((yield* json<FileBody>(file)).content).toBe("a")
				}),
			))
	})

	describe("the reconciliation scan cursor", () => {
		const marker = (artifactId: string, writeId: string, check: ArtifactWriteCheck) =>
			JSON.stringify({ artifact_id: artifactId, write_id: writeId, check })
		const keyOf = (artifactId: string, writeId: string) =>
			artifactMarkerKey(SCOPE, artifactId, writeId)
		const cursorOf = (store: { readonly objects: Map<string, Uint8Array> }) => {
			const bytes = store.objects.get(artifactReconcileCursorKey(SCOPE))
			return bytes === undefined ? null : new TextDecoder().decode(bytes)
		}

		it("gets past markers that keep waiting, and wraps to the start at the end", () =>
			withApi(({ call, store, reconcile, reconcileWithoutVersionRows }) =>
				Effect.gen(function* () {
					const { id } = yield* json<ArtifactBody>(
						yield* call("POST", "/v1/artifacts", {
							name: "A",
							files: [{ path: "a.txt", content: "1" }],
						}),
					)
					for (const version of [1, 2]) {
						yield* call("POST", `/v1/artifacts/${id}/versions`, {
							version,
							files: [{ path: "a.txt", content: String(version + 1) }],
						})
					}
					const writeIds = Array.from(
						{ length: 250 },
						(_, index) => `w${String(index).padStart(3, "0")}`,
					)
					for (const [index, writeId] of writeIds.entries()) {
						store.upload(
							keyOf(id, writeId),
							marker(id, writeId, {
								kind: "version",
								manifest: "x".repeat(64),
								expected_version: index < 200 ? 1 : 3,
							}),
						)
					}
					store.advanceClock(ARTIFACT_WRITE_GRACE_MS)
					yield* reconcileWithoutVersionRows
					expect(store.markers()).toHaveLength(250)
					expect(cursorOf(store)).toBe(keyOf(id, "w199"))
					yield* reconcileWithoutVersionRows
					expect(store.markers().sort()).toEqual(
						writeIds.slice(0, 200).map((writeId) => keyOf(id, writeId)),
					)
					expect(cursorOf(store)).toBeNull()
					yield* reconcile
					expect(store.markers()).toEqual([])
					expect(cursorOf(store)).toBeNull()
				}),
			))

		it("does not let a page of young markers hide an old one behind them", () =>
			withApi(({ store, reconcile }) =>
				Effect.gen(function* () {
					const old = keyOf("art_zzz_old", "w_old")
					store.upload(old, marker("art_zzz_old", "w_old", { kind: "create", manifest: "x" }))
					store.advanceClock(ARTIFACT_WRITE_GRACE_MS)
					const young = Array.from({ length: ARTIFACT_RECONCILE_PAGE }, (_, index) =>
						keyOf("art_young", `w${String(index).padStart(4, "0")}`),
					)
					for (const key of young) {
						const parsed = parseArtifactMarkerKey(SCOPE, key)
						store.upload(
							key,
							marker(parsed?.artifact_id ?? "", parsed?.write_id ?? "", {
								kind: "create",
								manifest: "x",
							}),
						)
					}
					yield* reconcile
					expect(store.markers()).toContain(old)
					expect(cursorOf(store)).toBe(young.at(-1))
					yield* reconcile
					expect(store.markers()).not.toContain(old)
					expect(store.markers()).toHaveLength(ARTIFACT_RECONCILE_PAGE)
					expect(cursorOf(store)).toBeNull()
				}),
			))
	})
})
