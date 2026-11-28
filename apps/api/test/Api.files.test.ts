import { describe, expect, it } from "@effect/vitest"
import { ArtifactVersionView } from "@checkfu/domain/Artifact/ArtifactVersionView.view"
import * as Effect from "effect/Effect"
import { makeApiHandler } from "../src/Http/Router.ts"
import {
	AUTH_HEADERS,
	extractSystemText,
	makeAssistantReply,
	makePiDurableTestLayer,
	sendAndSettle,
	sendRequest,
} from "./helpers/ApiHarness.ts"

type ApiFetch = Parameters<typeof sendRequest>[0]

interface ArtifactBody {
	readonly id: string
	readonly version: number
}

interface MountBody {
	readonly id: string
	readonly type: string
	readonly artifact_id: string
	readonly version: number
	readonly manifest: string
	readonly name: string
	readonly mount_path: string
}

interface SessionBody {
	readonly id: string
	readonly resources: ReadonlyArray<MountBody>
}

interface FileInput {
	readonly path: string
	readonly content: string
	readonly encoding?: "base64"
}

const request = (apiFetch: ApiFetch, method: string, path: string, body?: unknown) =>
	sendRequest(apiFetch, {
		method,
		path,
		headers: AUTH_HEADERS,
		...(body === undefined ? {} : { body }),
	})

const json = <A>(response: Response) => Effect.promise(() => response.json() as Promise<A>)

const MOUNT = "/mnt/artifacts/q3-data"

const withSessions = async (
	run: (
		apiFetch: ApiFetch,
		world: {
			readonly artifactFiles: ReturnType<typeof makePiDurableTestLayer>["artifactFiles"]
			readonly systems: Array<string>
			readonly onTurn: (look: () => Promise<void>) => void
			readonly artifactStore: ReturnType<typeof makePiDurableTestLayer>["artifactStore"]
			readonly createSession: (resources: ReadonlyArray<unknown>) => Effect.Effect<Response>
			readonly createArtifact: (
				name: string,
				files: ReadonlyArray<FileInput>,
			) => Effect.Effect<ArtifactBody>
			readonly lagVersionView: () => void
		},
	) => Effect.Effect<void>,
) => {
	const systems: Array<string> = []
	let look: () => Promise<void> = () => Promise.resolve()
	const { layer, closeAll, artifactFiles, artifactStore } = makePiDurableTestLayer(
		async (model, context) => {
			systems.push(extractSystemText(context))
			await look()
			return makeAssistantReply(model, null, "ok", 1, 1)
		},
	)
	try {
		await Effect.runPromise(
			Effect.gen(function* () {
				const versionViews = yield* ArtifactVersionView
				let lagging = false
				const { fetch: apiFetch } = yield* makeApiHandler.pipe(
					Effect.provideService(ArtifactVersionView, {
						...versionViews,
						get: (...args: Parameters<typeof versionViews.get>) => {
							if (lagging) {
								lagging = false
								return Effect.succeedNone
							}
							return versionViews.get(...args)
						},
					} as typeof versionViews),
				)
				const agent = yield* json<{ id: string }>(
					yield* request(apiFetch, "POST", "/v1/agents", { name: "Agent", model: "gpt-4o-mini" }),
				)
				const environment = yield* json<{ id: string }>(
					yield* request(apiFetch, "POST", "/v1/environments", { name: "Env" }),
				)
				yield* run(apiFetch, {
					artifactFiles,
					artifactStore,
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
					lagVersionView: () => {
						lagging = true
					},
					createArtifact: (name, files) =>
						Effect.flatMap(request(apiFetch, "POST", "/v1/artifacts", { name, files }), (res) =>
							json<ArtifactBody>(res),
						),
				})
			}).pipe(Effect.scoped, Effect.provide(layer)),
		)
	} finally {
		await closeAll()
	}
}

describe("Artifacts in a session", () => {
	it("serves the artifact's version as read-only files, and keeps that version for the session's life", () =>
		withSessions((apiFetch, { artifactFiles, systems, onTurn, createSession, createArtifact }) =>
			Effect.gen(function* () {
				const artifact = yield* createArtifact("Q3 Data", [
					{ path: "sales.csv", content: "region,total\nEMEA,10\n" },
					{ path: "notes/readme.md", content: "Totals are in thousands." },
				])
				const created = yield* createSession([{ type: "artifact", artifact_id: artifact.id }])
				expect(created.status).toBe(201)
				const session = yield* json<SessionBody>(created)
				expect(session.resources).toMatchObject([
					{
						id: expect.stringMatching(/^sesrsc_/),
						type: "artifact",
						artifact_id: artifact.id,
						version: 1,
						manifest: expect.stringMatching(/^[0-9a-f]{64}$/),
						name: "Q3 Data",
						mount_path: MOUNT,
					},
				])

				const seen = new Map<
					string,
					{ files: ReadonlyArray<string>; sales: string | null; pages?: ReadonlyArray<unknown> }
				>()
				const lookFrom = (sessionId: string) =>
					onTurn(async () => {
						const files = artifactFiles(sessionId)
						seen.set(sessionId, {
							files: await files.list(),
							sales: await files.read(`${MOUNT}/sales.csv`),
							pages: [
								await files.read(`${MOUNT}/sales.csv`, { offset: 13, length: 4 }),
								await files.read(`${MOUNT}/sales.csv`, { offset: 18, length: 100 }),
								await files.read(`${MOUNT}/sales.csv`, { offset: 100, length: 4 }),
							],
						})
					})

				lookFrom(session.id)
				yield* sendAndSettle(apiFetch, session.id, ["Sum the sales."], 1)
				expect(seen.get(session.id)).toEqual({
					files: [`${MOUNT}/notes/readme.md`, `${MOUNT}/sales.csv`],
					sales: "region,total\nEMEA,10\n",
					pages: ["EMEA", "10\n", ""],
				})
				expect(systems[0]).toContain(
					`Files mounted in your workspace, read-only:\n- ${MOUNT}: Q3 Data (version 1)`,
				)

				const second = yield* json<ArtifactBody>(
					yield* request(apiFetch, "POST", `/v1/artifacts/${artifact.id}/versions`, {
						version: 1,
						files: [{ path: "sales.csv", content: "region,total\nEMEA,12\n" }],
					}),
				)
				expect(second.version).toBe(2)
				yield* sendAndSettle(apiFetch, session.id, ["Again."], 2)
				expect(seen.get(session.id)?.sales).toBe("region,total\nEMEA,10\n")

				const latest = yield* json<SessionBody>(
					yield* createSession([{ type: "artifact", artifact_id: artifact.id }]),
				)
				const pinned = yield* json<SessionBody>(
					yield* createSession([{ type: "artifact", artifact_id: artifact.id, version: 1 }]),
				)
				expect(latest.resources[0]?.version).toBe(2)
				expect(pinned.resources[0]).toMatchObject({
					version: 1,
					manifest: session.resources[0]?.manifest,
				})
				lookFrom(latest.id)
				yield* sendAndSettle(apiFetch, latest.id, ["Sum."], 1)
				lookFrom(pinned.id)
				yield* sendAndSettle(apiFetch, pinned.id, ["Sum."], 1)
				expect(seen.get(latest.id)).toMatchObject({
					files: [`${MOUNT}/sales.csv`],
					sales: "region,total\nEMEA,12\n",
				})
				expect(seen.get(pinned.id)?.files).toContain(`${MOUNT}/notes/readme.md`)
			}),
		))

	it("pins an older version whose view has not caught up yet, once it does", () =>
		withSessions((apiFetch, { createSession, createArtifact, lagVersionView }) =>
			Effect.gen(function* () {
				const artifact = yield* createArtifact("Q3 Data", [{ path: "a.txt", content: "a" }])
				const added = yield* request(apiFetch, "POST", `/v1/artifacts/${artifact.id}/versions`, {
					version: 1,
					files: [{ path: "a.txt", content: "b" }],
				})
				expect(added.status).toBe(201)
				lagVersionView()
				const res = yield* createSession([
					{ type: "artifact", artifact_id: artifact.id, version: 1 },
				])
				expect(res.status).toBe(201)
			}),
		))

	it("refuses an artifact that is missing, deleted, has no such version or shares a mount path", () =>
		withSessions((apiFetch, { createSession, createArtifact }) =>
			Effect.gen(function* () {
				const file = [{ path: "a.txt", content: "a" }]
				const artifact = yield* createArtifact("Q3 Data", file)
				const mount = { type: "artifact", artifact_id: artifact.id }
				const refusal = (resources: ReadonlyArray<unknown>) =>
					Effect.flatMap(createSession(resources), (res) =>
						Effect.map(json<{ error: { message: string } }>(res), ({ error }) => [
							res.status,
							error.message,
						]),
					)

				expect(yield* refusal([{ ...mount, artifact_id: "art_nope" }])).toEqual([
					404,
					"Artifact art_nope not found.",
				])
				expect(yield* refusal([{ ...mount, version: 2 }])).toEqual([
					404,
					`Artifact ${artifact.id} has no version 2.`,
				])
				expect((yield* createSession([{ ...mount, version: 0 }])).status).toBe(400)
				expect((yield* createSession([mount, mount])).status).toBe(400)
				const twin = yield* createArtifact("q3 data!", file)
				expect(
					(yield* createSession([mount, { type: "artifact", artifact_id: twin.id }])).status,
				).toBe(400)

				const unnamed = yield* createArtifact("!!!", file)
				const mixed = yield* json<SessionBody>(
					yield* createSession([
						mount,
						{ type: "artifact", artifact_id: unnamed.id },
						{ type: "github_repository", url: "https://github.com/acme/api" },
					]),
				)
				expect(mixed.resources.map((resource) => resource.mount_path)).toEqual([
					MOUNT,
					`/mnt/artifacts/${unnamed.id}`,
					"/workspace/api",
				])

				const nine = yield* Effect.forEach(
					Array.from({ length: 9 }, (_, index) => `Set ${index}`),
					(name) => createArtifact(name, file),
				)
				const mounts = nine.map(({ id }) => ({ type: "artifact", artifact_id: id }))
				expect((yield* createSession(mounts)).status).toBe(400)
				expect((yield* createSession(mounts.slice(0, 8))).status).toBe(201)

				yield* request(apiFetch, "DELETE", `/v1/artifacts/${artifact.id}`)
				expect(yield* refusal([mount])).toEqual([404, `Artifact ${artifact.id} not found.`])
			}),
		))

	it("refuses a file listed before its artifact was deleted in the same turn", () =>
		withSessions(
			(apiFetch, { artifactFiles, artifactStore, onTurn, createSession, createArtifact }) =>
				Effect.gen(function* () {
					const artifact = yield* createArtifact("Q3 Data", [{ path: "a.txt", content: "a" }])
					const session = yield* json<SessionBody>(
						yield* createSession([{ type: "artifact", artifact_id: artifact.id }]),
					)
					const runPromise = Effect.runPromiseWith(yield* Effect.context<never>())
					let listed: ReadonlyArray<string> = []
					let after: string | null = "unread"
					onTurn(async () => {
						const files = artifactFiles(session.id)
						listed = await files.list()
						artifactStore.setBeforeDelete(Effect.sync(() => artifactStore.setFailing(true)))
						await runPromise(request(apiFetch, "DELETE", `/v1/artifacts/${artifact.id}`))
						artifactStore.setBeforeDelete(Effect.void)
						artifactStore.setFailing(false)
						after = await files.read(`${MOUNT}/a.txt`)
					})
					yield* sendAndSettle(apiFetch, session.id, ["Read it."], 1)
					expect(listed).toEqual([`${MOUNT}/a.txt`])
					expect(after).toBeNull()
				}),
		))

	it("fails a listing or a read whose bytes the store has lost, instead of showing an empty mount", () =>
		withSessions(
			(apiFetch, { artifactFiles, artifactStore, onTurn, createSession, createArtifact }) =>
				Effect.gen(function* () {
					const lose = (artifactId: string, kind: string) => {
						for (const key of artifactStore.objects.keys()) {
							if (key.includes(artifactId) && key.includes(kind)) {
								artifactStore.objects.delete(key)
							}
						}
					}
					const settled = (work: Promise<unknown>) =>
						work.then(
							(value) => `ok ${JSON.stringify(value)}`,
							() => "failed",
						)
					const outcomes: Array<string> = []
					const withLost = (kind: string, look: (sessionId: string) => Promise<void>) =>
						Effect.gen(function* () {
							const artifact = yield* createArtifact("Q3 Data", [{ path: "a.txt", content: "a" }])
							const session = yield* json<SessionBody>(
								yield* createSession([{ type: "artifact", artifact_id: artifact.id }]),
							)
							onTurn(async () => {
								lose(artifact.id, kind)
								await look(session.id)
							})
							yield* sendAndSettle(apiFetch, session.id, ["Read it."], 1)
						})
					yield* withLost("/blobs/", async (sessionId) => {
						const files = artifactFiles(sessionId)
						outcomes.push(await settled(files.list()), await settled(files.read(`${MOUNT}/a.txt`)))
					})
					yield* withLost("/manifests/", async (sessionId) => {
						outcomes.push(await settled(artifactFiles(sessionId).list()))
					})
					expect(outcomes).toEqual([`ok ["${MOUNT}/a.txt"]`, "failed", "failed"])
				}),
		))

	it("reads a pinned version's manifest once, however many chunks a large file takes", () =>
		withSessions(
			(apiFetch, { artifactFiles, artifactStore, onTurn, createSession, createArtifact }) =>
				Effect.gen(function* () {
					const content = "x".repeat(700 * 1024)
					const artifact = yield* createArtifact("Q3 Data", [{ path: "big.txt", content }])
					const session = yield* json<SessionBody>(
						yield* createSession([{ type: "artifact", artifact_id: artifact.id }]),
					)
					let manifestReads = 0
					const reads: Array<string | null> = []
					onTurn(async () => {
						artifactStore.setBeforeGet(
							Effect.sync(() => {
								manifestReads += 1
							}),
						)
						const files = artifactFiles(session.id)
						reads.push(await files.read(`${MOUNT}/big.txt`), await files.read(`${MOUNT}/big.txt`))
						artifactStore.setBeforeGet(Effect.void)
					})
					yield* sendAndSettle(apiFetch, session.id, ["Read it."], 1)
					expect(reads.map((text) => text?.length)).toEqual([content.length, content.length])
					expect(manifestReads).toBe(1)
				}),
		))

	it("stops serving an artifact once it is deleted, without failing the session's turns", () =>
		withSessions(
			(
				apiFetch,
				{ artifactFiles, artifactStore, systems, onTurn, createSession, createArtifact },
			) =>
				Effect.gen(function* () {
					const artifact = yield* createArtifact("Q3 Data", [{ path: "a.txt", content: "a" }])
					const early = yield* json<SessionBody>(
						yield* createSession([{ type: "artifact", artifact_id: artifact.id }]),
					)
					const late = yield* json<SessionBody>(
						yield* createSession([{ type: "artifact", artifact_id: artifact.id }]),
					)
					const seen: Array<[ReadonlyArray<string>, string | null]> = []
					const lookFrom = (sessionId: string) =>
						onTurn(async () => {
							const files = artifactFiles(sessionId)
							seen.push([await files.list(), await files.read(`${MOUNT}/a.txt`)])
						})

					lookFrom(early.id)
					yield* sendAndSettle(apiFetch, early.id, ["Read it."], 1)
					artifactStore.setBeforeDelete(Effect.sync(() => artifactStore.setFailing(true)))
					expect((yield* request(apiFetch, "DELETE", `/v1/artifacts/${artifact.id}`)).status).toBe(
						503,
					)
					artifactStore.setBeforeDelete(Effect.void)
					artifactStore.setFailing(false)
					yield* sendAndSettle(apiFetch, early.id, ["Read it again."], 2)
					lookFrom(late.id)
					yield* sendAndSettle(apiFetch, late.id, ["Read it."], 1)
					expect(seen).toEqual([
						[[`${MOUNT}/a.txt`], "a"],
						[[], null],
						[[], null],
					])
					expect(systems[0]).toContain(`${MOUNT}: Q3 Data (version 1)`)
					expect(systems[1]).not.toContain(MOUNT)
					expect(systems[2]).not.toContain(MOUNT)

					const events = yield* json<{ data: ReadonlyArray<{ type: string }> }>(
						yield* request(apiFetch, "GET", `/v1/sessions/${late.id}/events`),
					)
					expect(events.data.some((event) => event.type === "session.error")).toBe(false)
				}),
		))
})
