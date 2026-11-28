import { describe, expect, it } from "@effect/vitest"
import { MAX_SKILL_FILE_BYTES } from "@checkfu/sdk/Schemas"
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

interface SkillBody {
	readonly id: string
	readonly type: string
	readonly artifact_id: string
	readonly version: number
	readonly name: string
	readonly description: string
	readonly mount_path: string
}

interface SessionBody {
	readonly id: string
	readonly resources: ReadonlyArray<SkillBody>
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

const skillFile = (name: string, description: string, body = "# Steps\n1. Do the thing.\n") =>
	`---\nname: ${name}\ndescription: ${description}\n---\n${body}`

const PDF_SKILL = skillFile("pdf-forms", "Fill in PDF forms. Use when the user has a PDF form.")

const withSessions = async (
	run: (
		apiFetch: ApiFetch,
		world: {
			readonly artifactFiles: ReturnType<typeof makePiDurableTestLayer>["artifactFiles"]
			readonly artifactStore: ReturnType<typeof makePiDurableTestLayer>["artifactStore"]
			readonly systems: Array<string>
			readonly onTurn: (look: () => Promise<void>) => void
			readonly createSession: (resources: ReadonlyArray<unknown>) => Effect.Effect<Response>
			readonly createArtifact: (
				name: string,
				files: ReadonlyArray<FileInput>,
			) => Effect.Effect<{ readonly id: string }>
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
				const { fetch: apiFetch } = yield* makeApiHandler
				const agent = yield* json<{ id: string }>(
					yield* request(apiFetch, "POST", "/v1/agents", {
						name: "Agent",
						model: "gpt-4o-mini",
						system: "Be brief.",
					}),
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
					createArtifact: (name, files) =>
						Effect.flatMap(request(apiFetch, "POST", "/v1/artifacts", { name, files }), (res) =>
							json<{ id: string }>(res),
						),
				})
			}).pipe(Effect.scoped, Effect.provide(layer)),
		)
	} finally {
		await closeAll()
	}
}

describe("Skills in a session", () => {
	it("mounts a skill under its own name and tells the model when to read it", () =>
		withSessions((apiFetch, { artifactFiles, systems, onTurn, createSession, createArtifact }) =>
			Effect.gen(function* () {
				const artifact = yield* createArtifact("Anything At All", [
					{ path: "SKILL.md", content: PDF_SKILL },
					{ path: "scripts/fill.py", content: "print('fill')\n" },
				])
				const created = yield* createSession([{ type: "skill", artifact_id: artifact.id }])
				expect(created.status).toBe(201)
				const session = yield* json<SessionBody>(created)
				expect(session.resources).toMatchObject([
					{
						id: expect.stringMatching(/^sesrsc_/),
						type: "skill",
						artifact_id: artifact.id,
						version: 1,
						name: "pdf-forms",
						description: "Fill in PDF forms. Use when the user has a PDF form.",
						mount_path: "/mnt/skills/pdf-forms",
					},
				])

				let seen: ReadonlyArray<string> = []
				let read: string | null = null
				const look = async () => {
					const files = artifactFiles(session.id, "/mnt/skills")
					seen = await files.list()
					read = await files.read("/mnt/skills/pdf-forms/SKILL.md")
				}
				onTurn(look)
				yield* sendAndSettle(apiFetch, session.id, ["Fill this form."], 1)
				expect(seen).toEqual([
					"/mnt/skills/pdf-forms/SKILL.md",
					"/mnt/skills/pdf-forms/scripts/fill.py",
				])
				expect(read).toBe(PDF_SKILL)
				expect(systems[0]).toContain("Be brief.")
				expect(systems[0]).toContain(
					"Skills in your workspace. Each is a directory of instructions for one kind of task. When a task matches a skill's description, read its SKILL.md before you start:\n- /mnt/skills/pdf-forms/SKILL.md: pdf-forms. Fill in PDF forms. Use when the user has a PDF form.",
				)

				yield* request(apiFetch, "POST", `/v1/artifacts/${artifact.id}/versions`, {
					version: 1,
					files: [{ path: "SKILL.md", content: skillFile("pdf-forms", "Changed.") }],
				})
				yield* sendAndSettle(apiFetch, session.id, ["Again."], 2)
				expect(systems[1]).toBe(systems[0])
				expect(read).toBe(PDF_SKILL)
				const next = yield* json<SessionBody>(
					yield* createSession([{ type: "skill", artifact_id: artifact.id }]),
				)
				expect(next.resources[0]).toMatchObject({ version: 2, description: "Changed." })

				expect((yield* request(apiFetch, "DELETE", `/v1/artifacts/${artifact.id}`)).status).toBe(
					200,
				)
				yield* sendAndSettle(apiFetch, session.id, ["Continue without the skill."], 3)
				expect(systems[2]).toContain("Be brief.")
				expect(systems[2]).not.toContain("/mnt/skills/pdf-forms")
				expect(systems[2]).not.toContain("Fill in PDF forms")
				expect(seen).toEqual([])
				expect(read).toBeNull()
			}),
		))

	it("answers a store failure, not that it is no skill, when a SKILL.md's bytes are missing", () =>
		withSessions((_apiFetch, { artifactStore, createSession, createArtifact }) =>
			Effect.gen(function* () {
				const artifact = yield* createArtifact("Lost", [{ path: "SKILL.md", content: PDF_SKILL }])
				for (const key of artifactStore.objects.keys()) {
					if (key.includes(artifact.id) && key.includes("/blobs/")) {
						artifactStore.objects.delete(key)
					}
				}
				const res = yield* createSession([{ type: "skill", artifact_id: artifact.id }])
				const body = yield* json<{ error: { message: string } }>(res)
				expect([res.status, body.error.message]).toEqual([500, "Failed to load artifact files."])
			}),
		))

	it("answers 503 when skill storage is temporarily unavailable", () =>
		withSessions((_apiFetch, { artifactStore, createSession, createArtifact }) =>
			Effect.gen(function* () {
				const artifact = yield* createArtifact("Skill", [{ path: "SKILL.md", content: PDF_SKILL }])
				const resources = [{ type: "skill", artifact_id: artifact.id }]
				expect((yield* createSession(resources)).status).toBe(201)

				artifactStore.setFailing(true)
				const unavailable = yield* createSession(resources)
				const body = yield* json<{ error: { message: string } }>(unavailable)
				expect([unavailable.status, body.error.message]).toEqual([
					503,
					"Artifact storage is unavailable. Retry the request.",
				])

				artifactStore.setFailing(false)
				expect((yield* createSession(resources)).status).toBe(201)
			}),
		))

	it("refuses an artifact that is not a skill, and two skills with one name", () =>
		withSessions((apiFetch, { createSession, createArtifact }) =>
			Effect.gen(function* () {
				const refusal = (files: ReadonlyArray<FileInput>) =>
					Effect.gen(function* () {
						const artifact = yield* createArtifact("Candidate", files)
						const res = yield* createSession([{ type: "skill", artifact_id: artifact.id }])
						const body = yield* json<{ error: { message: string } }>(res)
						return [res.status, body.error.message.replace(artifact.id, "<id>")]
					})

				expect(yield* refusal([{ path: "README.md", content: "# Hi" }])).toEqual([
					400,
					"Artifact <id> is not a skill: it has no SKILL.md at its root.",
				])
				expect(yield* refusal([{ path: "docs/SKILL.md", content: PDF_SKILL }])).toEqual([
					400,
					"Artifact <id> is not a skill: it has no SKILL.md at its root.",
				])
				for (const content of [
					"# No frontmatter",
					"---\nname: pdf-forms\n---\nNo description.",
					skillFile("../etc", "Escapes its directory."),
					skillFile("PDF Forms", "Name is not a directory name."),
					skillFile("pdf-forms", "x".repeat(1025)),
				]) {
					const [status, message] = yield* refusal([{ path: "SKILL.md", content }])
					expect([content.slice(0, 40), status]).toEqual([content.slice(0, 40), 400])
					expect(message).toMatch(/^Artifact <id> is not a skill: .+\.$/)
				}

				const manual = yield* refusal([
					{
						path: "SKILL.md",
						content:
							"---\nname: deploy\ndescription: Deploy the app.\ndisable-model-invocation: true\n---\nSteps.",
					},
				])
				expect(manual[0]).toBe(400)
				expect(manual[1]).toContain("disable-model-invocation")
				const frontmatter = new TextEncoder().encode(skillFile("binary", "Has a binary body."))
				const binary = Uint8Array.from([...frontmatter, 0xff, 0xfe, 0x00])
				expect(
					yield* refusal([
						{
							path: "SKILL.md",
							content: Buffer.from(binary).toString("base64"),
							encoding: "base64",
						},
					]),
				).toEqual([400, "Artifact <id> is not a skill: its SKILL.md is not UTF-8 text."])
				const long = skillFile("long", "Too long to load.")
				const oversized = long + "x".repeat(MAX_SKILL_FILE_BYTES + 1 - long.length)
				expect(yield* refusal([{ path: "SKILL.md", content: oversized }])).toEqual([
					400,
					`Artifact <id> is not a skill: its SKILL.md is ${MAX_SKILL_FILE_BYTES + 1} bytes; the limit is ${MAX_SKILL_FILE_BYTES}.`,
				])
				const longest = long + "x".repeat(MAX_SKILL_FILE_BYTES - long.length)
				const fits = yield* createArtifact("Fits", [{ path: "SKILL.md", content: longest }])
				expect((yield* createSession([{ type: "skill", artifact_id: fits.id }])).status).toBe(201)

				const one = yield* createArtifact("One", [{ path: "SKILL.md", content: PDF_SKILL }])
				const two = yield* createArtifact("Two", [{ path: "SKILL.md", content: PDF_SKILL }])
				const other = yield* createArtifact("Other", [
					{ path: "SKILL.md", content: skillFile("code-review", "Review a change.") },
				])
				const skill = (artifact: { readonly id: string }) => ({
					type: "skill",
					artifact_id: artifact.id,
				})
				expect((yield* createSession([skill(one), skill(two)])).status).toBe(400)
				expect((yield* createSession([skill({ id: "art_nope" })])).status).toBe(404)
				expect((yield* createSession([{ ...skill(one), version: 2 }])).status).toBe(404)

				const both = yield* json<SessionBody>(
					yield* createSession([
						skill(one),
						skill(other),
						{ type: "artifact", artifact_id: one.id },
					]),
				)
				expect(both.resources.map((resource) => resource.mount_path)).toEqual([
					"/mnt/skills/pdf-forms",
					"/mnt/skills/code-review",
					"/mnt/artifacts/one",
				])
			}),
		))

	it("takes every skill the Agent Skills parser takes, whatever its script", () =>
		withSessions((_apiFetch, { createSession, createArtifact }) =>
			Effect.gen(function* () {
				const longDescription = "🧾".repeat(600)
				const resume = yield* createArtifact("Resume", [
					{ path: "SKILL.md", content: skillFile("résumé", "Write a résumé.") },
				])
				const emoji = yield* createArtifact("Emoji", [
					{ path: "SKILL.md", content: skillFile("receipts", longDescription) },
				])
				const created = yield* createSession([
					{ type: "skill", artifact_id: resume.id },
					{ type: "skill", artifact_id: emoji.id },
				])
				expect(created.status).toBe(201)
				const session = yield* json<SessionBody>(created)
				expect(session.resources).toMatchObject([
					{ name: "résumé", mount_path: "/mnt/skills/résumé" },
					{ name: "receipts", description: longDescription },
				])
			}),
		))
})
