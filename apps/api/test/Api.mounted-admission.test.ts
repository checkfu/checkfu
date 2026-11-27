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

it("checks resolved file mounts at commit in each initial-message mode", async () => {
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
				for (const initial_events of messages) {
					const target = yield* file()
					const url = `/v1/files/${target.id}`
					const mount = { type: "file", file_id: target.id }
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
					expect(refused.status).toBe(404)
					if (captured === undefined) {
						throw new Error("The admission boundary was not reached")
					}
					expect((yield* sessions.get(captured.session_id))._tag).toBe("Uninitialized")
				}
				const upload = yield* file()
				const secondFile = yield* file()
				const mounts = {
					agent: agent.id,
					environment_id: env.id,
					resources: [
						{ type: "file", file_id: upload.id, mount_path: "first.txt" },
						{ type: "file", file_id: upload.id, mount_path: "second.txt" },
						{ type: "file", file_id: secondFile.id, mount_path: "third.txt" },
					],
				}
				const submit = (fetch: typeof api) =>
					sendRequest(fetch, {
						method: "POST",
						path: "/v1/sessions",
						body: mounts,
						headers: { ...AUTH_HEADERS, "idempotency-key": "admit-two-files" },
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
				])
				if (captured === undefined) {
					throw new Error("Mounted admission did not receive the file request")
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
				for (const [index, change] of [{ size: 12 }, { sha256: "0".repeat(64) }].entries()) {
					const session_id = SessionId.make(`sess_invalid_mount_${index}`)
					const resources = command.resources.map((mount) =>
						mount.type === "file" && mount.file_id === secondFile.id
							? { ...mount, ...change }
							: mount,
					)
					const denied = yield* Effect.flip(
						admission.send(new AdmitMountedSession({ ...command, session_id, resources })),
					)
					expect(denied._tag).toBe("FileNotFound")
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
			}).pipe(Effect.scoped, Effect.provide(layer)),
		)
	} finally {
		await closeAll()
	}
}, 30_000)
