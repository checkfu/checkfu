import { OpenAutomationSession } from "@checkfu/domain/Automation/OpenAutomationSession.command"
import {
	AdmitSession,
	AdmitSessionWithMessages,
} from "@checkfu/domain/Session/AdmitSession.command"
import { SessionId } from "@checkfu/domain/Session/Session.id"
import {
	AdmitMountedSession,
	AdmitMountedSessionDecision,
} from "@checkfu/domain/Session/AdmitMountedSession.decision"
import { Session } from "@checkfu/domain/Session/Session.aggregate"
import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { makeApiHandler } from "../src/Http/Router.ts"
import {
	AUTH_HEADERS,
	makeAssistantReply,
	makePiDurableTestLayer,
	sendRequest,
} from "./helpers/ApiHarness.ts"

it("checks resolved file, skill and artifact mounts at commit in each initial-message mode", async () => {
	const { layer, closeAll } = makePiDurableTestLayer(async (model) =>
		makeAssistantReply(model, null, "ok", 1, 1),
	)
	try {
		await Effect.runPromise(
			Effect.gen(function* () {
				const { fetch: api } = yield* makeApiHandler
				const admission = yield* AdmitMountedSessionDecision
				const sessions = yield* Session
				let beforeCommit: Effect.Effect<unknown> = Effect.void
				let captured: AdmitMountedSession | undefined
				const { fetch: intercepted } = yield* makeApiHandler.pipe(
					Effect.provideService(AdmitMountedSessionDecision, {
						...admission,
						send: (command, options) => {
							captured = command
							return beforeCommit.pipe(Effect.andThen(admission.send(command, options)))
						},
					}),
				)
				const json = <A>(response: Response) => Effect.promise(() => response.json() as Promise<A>)
				const create = (path: string, body: unknown) =>
					sendRequest(api, { method: "POST", path, body, headers: AUTH_HEADERS }).pipe(
						Effect.flatMap((response) => {
							expect(response.status).toBe(201)
							return json<{ id: string }>(response)
						}),
					)
				const agent = yield* create("/v1/agents", { name: "Agent", model: "gpt-4o-mini" })
				const env = yield* create("/v1/environments", { name: "Test" })
				const skill = "---\nname: example\ndescription: Example skill\n---\n# Example"
				const artifact = (name = "Example") =>
					create("/v1/artifacts", {
						name,
						files: [{ path: "SKILL.md", content: skill }],
					})
				const file = () =>
					sendRequest(api, {
						method: "POST",
						path: "/v1/files?filename=a.txt",
						headers: { ...AUTH_HEADERS, "content-type": "text/plain", "content-length": "1" },
						rawBody: "x",
					}).pipe(
						Effect.flatMap((response) => {
							expect(response.status).toBe(201)
							return json<{ id: string }>(response)
						}),
					)
				const messages = [0, 1, 2].map((length) =>
					Array.from({ length }, () => ({
						type: "user.message",
						content: [{ type: "text", text: "Read." }],
					})),
				)
				for (const type of ["file", "artifact", "skill"] as const) {
					for (const initial_events of messages) {
						const target = yield* type === "file" ? file() : artifact()
						const url = type === "file" ? `/v1/files/${target.id}` : `/v1/artifacts/${target.id}`
						const mount =
							type === "file"
								? { type, file_id: target.id }
								: { type, artifact_id: target.id, version: 1 }
						const body = {
							agent: agent.id,
							environment_id: env.id,
							resources: [mount],
							initial_events,
						}
						beforeCommit = sendRequest(api, {
							method: "DELETE",
							path: url,
							headers: AUTH_HEADERS,
						}).pipe(Effect.tap((res) => Effect.sync(() => expect(res.status).toBe(200))))
						const refused = yield* sendRequest(intercepted, {
							method: "POST",
							path: "/v1/sessions",
							body,
							headers: AUTH_HEADERS,
						})
						expect([type, initial_events.length, refused.status]).toEqual([
							type,
							initial_events.length,
							404,
						])
						if (captured === undefined) {
							throw new Error("The admission boundary was not reached")
						}
						expect((yield* sessions.get(captured.session_id))._tag).toBe("Uninitialized")
					}
				}
				const upload = yield* file()
				const secondFile = yield* file()
				const firstArtifact = yield* artifact("first")
				const secondArtifact = yield* artifact("second")
				const mounts = {
					agent: agent.id,
					environment_id: env.id,
					resources: [
						{ type: "file", file_id: upload.id, mount_path: "first.txt" },
						{ type: "file", file_id: upload.id, mount_path: "second.txt" },
						{ type: "file", file_id: secondFile.id, mount_path: "third.txt" },
						{ type: "artifact", artifact_id: firstArtifact.id, version: 1 },
						{ type: "artifact", artifact_id: secondArtifact.id, version: 1 },
					],
				}
				const submit = (fetch: typeof api) =>
					sendRequest(fetch, {
						method: "POST",
						path: "/v1/sessions",
						body: mounts,
						headers: { ...AUTH_HEADERS, "idempotency-key": "admit-two-files-and-two-artifacts" },
					})
				beforeCommit = Effect.void
				const acceptedMounts = yield* submit(intercepted)
				expect(acceptedMounts.status).toBe(201)
				const mounted = yield* json<{
					id: string
					resources: ReadonlyArray<{ mount_path: string }>
				}>(acceptedMounts)
				expect(mounted.resources.map((mount) => mount.mount_path.split("/").at(-1))).toEqual([
					"first.txt",
					"second.txt",
					"third.txt",
					"first",
					"second",
				])
				if (captured === undefined) {
					throw new Error("Mounted admission did not receive the mixed request")
				}
				const { _tag, ...command } = captured
				expect(_tag).toBe("AdmitMountedSession")
				expect(() => new AdmitSession(command)).toThrow()
				expect(
					() =>
						new AdmitSessionWithMessages({
							...command,
							initial_messages: { count: 1, messages: '["x"]' },
						}),
				).toThrow()
				expect(() => new OpenAutomationSession({ ...command, text: "x" })).toThrow()
				for (const [index, change] of [
					{ size: 12 },
					{ sha256: "0".repeat(64) },
					{ version: 2 },
				].entries()) {
					const session_id = SessionId.make(`sess_invalid_mount_${index}`)
					const resources = command.resources.map((mount) =>
						(mount.type === "file" && !("version" in change) && mount.file_id === secondFile.id) ||
						(mount.type === "artifact" &&
							"version" in change &&
							mount.artifact_id === secondArtifact.id)
							? { ...mount, ...change }
							: mount,
					)
					const denied = yield* Effect.flip(
						admission.send(new AdmitMountedSession({ ...command, session_id, resources })),
					)
					expect(denied._tag).toBe("version" in change ? "ArtifactVersionNotFound" : "FileNotFound")
					expect((yield* sessions.get(session_id))._tag).toBe("Uninitialized")
				}
				yield* sendRequest(api, {
					method: "DELETE",
					path: `/v1/files/${upload.id}`,
					headers: AUTH_HEADERS,
				})
				const replayed = yield* submit(api)
				expect(replayed.status).toBe(201)
				expect(yield* json(replayed)).toMatchObject({
					id: mounted.id,
					resources: mounted.resources,
				})
				const pin = yield* artifact()
				const body = {
					agent: agent.id,
					environment_id: env.id,
					resources: [{ type: "skill", artifact_id: pin.id, version: 1 }],
				}
				const headers = { ...AUTH_HEADERS, "idempotency-key": "mounted-session-replay" }
				beforeCommit = sendRequest(api, {
					method: "POST",
					path: `/v1/artifacts/${pin.id}/versions`,
					headers: AUTH_HEADERS,
					body: { version: 1, files: [{ path: "SKILL.md", content: skill + "\nNew revision." }] },
				}).pipe(Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(201))))
				const first = yield* sendRequest(intercepted, {
					method: "POST",
					path: "/v1/sessions",
					headers,
					body,
				})
				expect(first.status).toBe(201)
				const accepted = yield* json<{ id: string; resources: ReadonlyArray<{ version: number }> }>(
					first,
				)
				expect(accepted.resources[0]?.version).toBe(1)
				yield* sendRequest(api, {
					method: "DELETE",
					path: `/v1/artifacts/${pin.id}`,
					headers: AUTH_HEADERS,
				})
				const replay = yield* sendRequest(api, {
					method: "POST",
					path: "/v1/sessions",
					headers,
					body,
				})
				expect(replay.status).toBe(201)
				expect(yield* json(replay)).toMatchObject({
					id: accepted.id,
					resources: accepted.resources,
				})
				expect(
					(yield* sendRequest(api, {
						method: "POST",
						path: "/v1/sessions",
						headers,
						body: { ...body, title: "another intent" },
					})).status,
				).toBe(409)
			}).pipe(Effect.scoped, Effect.provide(layer)),
		)
	} finally {
		await closeAll()
	}
}, 30_000)
