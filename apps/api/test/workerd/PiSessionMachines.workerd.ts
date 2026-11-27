import { Checkfu, accumulateSessionEvent } from "@checkfu/sdk"
import type { SessionMessagePreview } from "@checkfu/sdk"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { FakeGitHubServer } from "./FakeGitHubServer.ts"
import type { FakeOpenAIAction, FakeOpenAIResponsesServer } from "./FakeOpenAIResponsesServer.ts"
import { startFakeMcpServer } from "./FakeMcpServer.ts"
import { startScriptedMcpServer } from "./ScriptedMcpServer.ts"
import { toolUseOf } from "@checkfu/domain/Session/ToolEventBounds"
import { toolUseIdFromEvent } from "@checkfu/domain/Session/Session.id"
import type { SessionResource } from "./WorkerdStack.ts"
import {
	TEST_API_KEY,
	TEST_GITHUB_TOKEN,
	AUTH_HEADERS,
	localR2,
	artifactBucketName,
	sha256,
	sleep,
	parseResponseJson,
	stripAnsi,
	startAlchemyDev,
	limitedTo,
	runsScript,
	userMessage,
} from "./WorkerdStack.ts"
import { piSessionHelpers, savedPaths, startPiSessionStack } from "./PiSessionStack.ts"

const sendData = (root: string, path: string, method = "GET", data?: unknown, key?: string) =>
	fetch(new URL(`_/data/${path}`, root), {
		method,
		...(data === undefined
			? {}
			: {
					headers: {
						"content-type": "application/json",
						...(key === undefined ? {} : { "idempotency-key": key }),
					},
					body: JSON.stringify({ data }),
				}),
	})

describe("PiSession real Durable Object under workerd: restarts, outputs, machines and connections", () => {
	let fakeOpenAI: FakeOpenAIResponsesServer
	let fakeGitHub: FakeGitHubServer
	let baseUrl: string
	let stage: string
	let stopWorker: (() => Promise<void>) | undefined
	let haltWorker: (() => Promise<void>) | undefined
	let workerLogs: ReadonlyArray<string> = []
	let workerStage: string
	let agentId: string
	let environmentId: string

	const {
		apiFetch,
		apiJson,
		createResource,
		createSession,
		waitForSession,
		listAllEvents,
		storedMemories,
		replyAfterTurn,
		outputsAt,
		fileBytes,
		uploadFile,
	} = piSessionHelpers({
		baseUrl: () => baseUrl,
		agentId: () => agentId,
		environmentId: () => environmentId,
	})

	beforeAll(async () => {
		const started = await startPiSessionStack()
		fakeOpenAI = started.fakeOpenAI
		fakeGitHub = started.fakeGitHub
		baseUrl = started.worker.baseUrl
		stage = started.worker.stage
		stopWorker = started.worker.stop
		haltWorker = started.worker.halt
		workerLogs = started.worker.logs
		workerStage = started.worker.stage
		agentId = started.agentId
		environmentId = started.environmentId
	}, 240_000)

	afterAll(async () => {
		await stopWorker?.()
		await fakeOpenAI?.close()
		await fakeGitHub?.close()
	}, 30_000)

	it("reaches memory stores in a turn Pi resumes after the Workers restart mid-turn", async () => {
		const store = await createResource<{ readonly id: string }>("/v1/memory_stores", {
			name: "Journal",
		})
		const session = await createResource<SessionResource>("/v1/sessions", {
			agent: agentId,
			environment_id: environmentId,
			resources: [{ type: "memory_store", memory_store_id: store.id }],
		})
		const prompt = "Keep a journal across the restart."
		let restarted = false
		const steps: ReadonlyArray<FakeOpenAIAction> = [
			{
				kind: "tool_call",
				name: "write",
				arguments: { path: "/mnt/memory/journal/before.md", content: "Written before." },
			},
			{
				kind: "tool_call",
				name: "write",
				arguments: { path: "/mnt/memory/journal/after.md", content: "Written after." },
			},
			{ kind: "tool_call", name: "read", arguments: { path: "/mnt/memory/journal/before.md" } },
		]
		fakeOpenAI.setHandler((req) => {
			if (req.lastUserText !== prompt) {
				return { kind: "reply", text: "unexpected" }
			}
			if (req.toolOutputs.length === 1 && !restarted) {
				return { kind: "hold" }
			}
			return (
				steps[req.toolOutputs.length] ?? {
					kind: "reply",
					text: `Done: ${req.toolOutputs.join(" | ")}`,
				}
			)
		})

		const sent = await apiJson(`/v1/sessions/${session.id}/events`, {
			method: "POST",
			body: { events: [{ type: "user.message", content: [{ type: "text", text: prompt }] }] },
		})
		expect(sent.status).toBe(200)
		await fakeOpenAI.waitForRequest(
			(req) => req.lastUserText === prompt && req.toolOutputs.length === 1,
			30_000,
		)

		await haltWorker?.()
		restarted = true
		const worker = await startAlchemyDev(fakeOpenAI.baseUrl, fakeGitHub.baseUrl, stage)
		baseUrl = worker.baseUrl
		stopWorker = worker.stop
		haltWorker = worker.halt
		workerLogs = worker.logs

		await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 1, 120_000)
		const reply = (await listAllEvents(session.id)).filter((e) => e.type === "agent.message").at(-1)
			?.content?.[0]?.text
		expect(reply).toContain("Written before.")
		expect(await storedMemories(store.id)).toEqual({
			"/after.md": "Written after.",
			"/before.md": "Written before.",
		})
	}, 240_000)

	it("lets the model save a directory as an artifact, and add a version when the files change", async () => {
		let tailOffset = 0
		const steps = new Map<string, ReadonlyArray<FakeOpenAIAction>>(
			Object.entries({
				"Build the report.": [
					{
						kind: "tool_call",
						name: "write",
						arguments: { path: "/workspace/site/index.html", content: "<h1>Q3</h1>" },
					},
					{
						kind: "tool_call",
						name: "write",
						arguments: { path: "/workspace/site/assets/app.js", content: "start()" },
					},
					{
						kind: "tool_call",
						name: "save_artifact",
						arguments: { name: "Q3 report", directory: "/workspace/site" },
					},
				],
				"Save it again.": [
					{
						kind: "tool_call",
						name: "save_artifact",
						arguments: { name: "Q3 report", directory: "/workspace/site" },
					},
				],
				"Correct the title.": [
					{
						kind: "tool_call",
						name: "write",
						arguments: { path: "/workspace/site/index.html", content: "<h1>Q3, corrected</h1>" },
					},
					{
						kind: "tool_call",
						name: "save_artifact",
						arguments: { name: "Q3 report", directory: "/workspace/site" },
					},
				],
				"Save nothing.": [
					{
						kind: "tool_call",
						name: "save_artifact",
						arguments: { name: "Empty", directory: "/workspace/nowhere" },
					},
				],
				"Append one row.": [
					{
						kind: "tool_call",
						callId: "provider-repeated-id".repeat(8),
						name: "artifact_data",
						arguments: { name: "Q3 report", collection: "rows", operation: "add", data: "row" },
					},
				],
				"Fill in the numbers.": [
					{
						kind: "tool_call",
						name: "artifact_data",
						arguments: {
							name: "Q3 report",
							collection: "numbers",
							operation: "put",
							id: "revenue",
							data: { q3: 1200 },
						},
					},
					{
						kind: "tool_call",
						name: "artifact_data",
						arguments: { name: "Q3 report", collection: "numbers", operation: "list" },
					},
				],
				"Measure the report's collection.": [
					{
						kind: "tool_call",
						name: "artifact_data",
						arguments: { name: "Q3 report", collection: "measured", operation: "list", limit: 100 },
					},
				],
				"Read the report's large note.": [
					{
						kind: "tool_call",
						name: "artifact_data",
						arguments: { name: "Q3 report", collection: "notes", operation: "get", id: "private" },
					},
				],
				"Read another report's numbers.": [
					{
						kind: "tool_call",
						name: "artifact_data",
						arguments: { name: "Not saved here", collection: "numbers", operation: "list" },
					},
				],
			}),
		)
		fakeOpenAI.setHandler((req) => {
			const latest = req.toolOutputs.at(-1) ?? ""
			const path = /"path":"(\/mnt\/artifact-data-results\/[^"]+)"/u.exec(latest)?.[1]
			if (req.lastUserText === "Measure the report's collection." && path !== undefined) {
				return { kind: "tool_call", name: "read", arguments: { path, byteOffset: tailOffset } }
			}
			if (req.lastUserText === "Read the report's large note." && path !== undefined) {
				return { kind: "tool_call", name: "read", arguments: { path, byteOffset: 0 } }
			}
			return (
				steps.get(req.lastUserText)?.[req.toolOutputs.length] ?? {
					kind: "reply",
					text: `Done: ${latest}`,
				}
			)
		})
		const session = await createSession()
		const saved = await replyAfterTurn(session.id, "Build the report.", 1)
		const artifactId = /art_[0-9a-f]{32}/u.exec(saved)?.[0] ?? ""
		expect(saved).toContain(`Saved "Q3 report" as artifact ${artifactId}, version 1, with 2 files.`)
		const artifact = await apiJson<{
			readonly name: string
			readonly version: number
			readonly files: ReadonlyArray<{ readonly path: string }>
		}>(`/v1/artifacts/${artifactId}`)
		expect(artifact.status).toBe(200)
		expect(artifact.body).toMatchObject({
			name: "Q3 report",
			version: 1,
			files: [{ path: "assets/app.js" }, { path: "index.html" }],
		})
		const page = await apiFetch(`/v1/artifacts/${artifactId}/versions/1/content?file=index.html`)
		expect(await page.text()).toBe("<h1>Q3</h1>")

		expect(await replyAfterTurn(session.id, "Save it again.", 2)).toContain(
			`"Q3 report" is unchanged: artifact ${artifactId} is still at version 1`,
		)
		expect(await replyAfterTurn(session.id, "Correct the title.", 3)).toContain(
			`as artifact ${artifactId}, version 2, with 2 files.`,
		)
		const corrected = await apiFetch(
			`/v1/artifacts/${artifactId}/versions/2/content?file=index.html`,
		)
		expect(await corrected.text()).toBe("<h1>Q3, corrected</h1>")
		expect(await replyAfterTurn(session.id, "Save nothing.", 4)).toMatch(
			/\/workspace\/nowhere (?:is not a directory|holds no files)\./u,
		)

		const filled = await replyAfterTurn(session.id, "Fill in the numbers.", 5)
		expect(filled).toContain('"id":"revenue"')
		expect(filled).toContain('"next_page":null')
		const numbers = await apiJson<{ readonly data: ReadonlyArray<{ readonly data: unknown }> }>(
			`/v1/artifacts/${artifactId}/data/numbers`,
		)
		expect(numbers.body.data.map((document) => document.data)).toEqual([{ q3: 1200 }])
		expect(await replyAfterTurn(session.id, "Read another report's numbers.", 6)).toContain(
			'No artifact named "Not saved here" has been saved in this session.',
		)
		const note = await apiJson(`/v1/artifacts/${artifactId}/data/notes/private`, {
			method: "PUT",
			body: { data: "a".repeat(25_000) },
		})
		expect(note.status).toBe(200)
		expect(await replyAfterTurn(session.id, "Read the report's large note.", 7)).toMatch(
			/"next_byte_offset":4096/u,
		)
		for (const turn of [8, 9]) {
			expect(await replyAfterTurn(session.id, "Append one row.", turn)).toContain('"data":"row"')
		}
		const rows = await apiJson<{ readonly data: ReadonlyArray<{ readonly id: string }> }>(
			`/v1/artifacts/${artifactId}/data/rows`,
		)
		expect(rows.body.data).toHaveLength(2)
		expect(new Set(rows.body.data.map(({ id }) => id)).size).toBe(2)
		if (process.env["CHECKFU_MEASURE_ARTIFACT_PAGES"] === "1") {
			const artifactPath = `/v1/artifacts/${artifactId}`
			const version = await apiFetch(`${artifactPath}/versions`, {
				method: "POST",
				body: {
					version: 2,
					files: [
						{ path: "index.html", content: "<p>Measurements</p>" },
						{
							path: "artifact.json",
							content: JSON.stringify({
								capabilities: { database: { collections: { measured: { visitors: "read" } } } },
							}),
						},
					],
				},
			})
			expect(version.status).toBe(201)
			const link = await apiJson<{ url: string }>(`${artifactPath}/versions/3/links`, {
				method: "POST",
				body: { access: "read" },
			})
			expect(link.status).toBe(201)
			const collection = `${artifactPath}/data/measured`
			const data = "x".repeat(65_534)
			for (let i = 0; i < 100; i++) {
				const written = await apiFetch(`${collection}/r${i}`, { method: "PUT", body: { data } })
				expect(written.status).toBe(200)
				await written.arrayBuffer()
			}
			const owner = await (await apiFetch(`${collection}?limit=100`)).text()
			const visitor = await (await sendData(link.body.url, "measured?limit=100")).text()
			const page = JSON.parse(owner) as { data: ReadonlyArray<unknown>; next_page: string | null }
			expect(page.data).toHaveLength(8)
			expect(page.next_page).toBeTypeOf("string")
			expect(JSON.parse(visitor)).toEqual(page)
			const bytes = new TextEncoder().encode(owner).byteLength
			tailOffset = bytes - 32
			const tail = await replyAfterTurn(session.id, "Measure the report's collection.", 10)
			const result = JSON.parse(tail.replace(/^Done: /u, "")) as {
				text: string
				next_byte_offset: number | null
			}
			expect(result.next_byte_offset).toBeNull()
			expect(result.text).toBe(owner.slice(-32))
			process.stdout.write(
				`${JSON.stringify({ rows: page.data.length, next_page: page.next_page, ownerBytes: bytes, visitorBytes: new TextEncoder().encode(visitor).byteLength, agentBytes: tailOffset + new TextEncoder().encode(result.text).byteLength })}\n`,
			)
		}
	}, 240_000)

	const uploadText = async (filename: string, text: string) => {
		const response = await uploadFile(`filename=${filename}`, new TextEncoder().encode(text))
		expect(response.status, await response.clone().text()).toBe(201)
		return (await response.json()) as { readonly id: string }
	}

	it("places uploaded files in the uploads directory, where the model can read them and cannot change them", async () => {
		const sales = await uploadText("sales.csv", "region,total\nEMEA,4217\n")
		const notes = await uploadText("notes.md", "Totals are in thousands.")
		const session = await createResource<SessionResource>("/v1/sessions", {
			agent: agentId,
			environment_id: environmentId,
			resources: [
				{ type: "file", file_id: sales.id, mount_path: "data/q3.csv" },
				{ type: "file", file_id: notes.id },
			],
		})
		const uploads = "/mnt/session/uploads"
		const steps = new Map<string, ReadonlyArray<FakeOpenAIAction>>(
			Object.entries({
				"What did EMEA sell?": [
					{ kind: "tool_call", name: "read", arguments: { path: `${uploads}/data/q3.csv` } },
				],
				"Fix the total.": [
					{
						kind: "tool_call",
						name: "write",
						arguments: { path: `${uploads}/data/q3.csv`, content: "EMEA,0" },
					},
					{ kind: "tool_call", name: "read", arguments: { path: `${uploads}/data/q3.csv` } },
					{ kind: "tool_call", name: "read", arguments: { path: `${uploads}/notes.md` } },
				],
				"What is there?": [
					{ kind: "tool_call", name: "find", arguments: { pattern: "**/*", path: uploads } },
				],
			}),
		)
		fakeOpenAI.setHandler(
			(req) =>
				steps.get(req.lastUserText)?.[req.toolOutputs.length] ?? {
					kind: "reply",
					text: `Done: ${req.toolOutputs.join(" | ")}`,
				},
		)
		const startCount = fakeOpenAI.requests.length

		expect(await replyAfterTurn(session.id, "What did EMEA sell?", 1)).toContain("EMEA,4217")
		const refused = await replyAfterTurn(session.id, "Fix the total.", 2)
		expect(refused).toContain(`read-only mount at ${uploads}: cannot modify`)
		expect(refused).toContain("EMEA,4217")
		expect(refused).toContain("Totals are in thousands.")
		const found = await replyAfterTurn(session.id, "What is there?", 3)
		expect(found).toContain("data/q3.csv")
		expect(found).toContain("notes.md")

		const systemText = fakeOpenAI.requests[startCount]?.messages
			.filter((message) => message.role === "system" || message.role === "developer")
			.map((message) => message.text)
			.join("\n")
		expect(systemText).toContain(`- ${uploads}/data/q3.csv (23 bytes)`)
		expect(systemText).toContain(`- ${uploads}/notes.md (24 bytes)`)
	}, 180_000)

	it("mounts an artifact version as read-only files the model can read and cannot change", async () => {
		const artifact = await createResource<{ readonly id: string }>("/v1/artifacts", {
			name: "Q3 Data",
			files: [
				{ path: "sales.csv", content: "region,total\nEMEA,4217\n" },
				{ path: "img/pixel.bin", content: "AAEC/w==", encoding: "base64" },
			],
		})
		const session = await createResource<SessionResource>("/v1/sessions", {
			agent: agentId,
			environment_id: environmentId,
			resources: [{ type: "artifact", artifact_id: artifact.id }],
		})
		const steps = new Map<string, ReadonlyArray<FakeOpenAIAction>>(
			Object.entries({
				"What did EMEA sell?": [
					{
						kind: "tool_call",
						name: "read",
						arguments: { path: "/mnt/artifacts/q3-data/sales.csv" },
					},
				],
				"Fix the total.": [
					{
						kind: "tool_call",
						name: "write",
						arguments: { path: "/mnt/artifacts/q3-data/sales.csv", content: "EMEA,0" },
					},
					{
						kind: "tool_call",
						name: "read",
						arguments: { path: "/mnt/artifacts/q3-data/sales.csv" },
					},
				],
				"What else is there?": [
					{
						kind: "tool_call",
						name: "find",
						arguments: { pattern: "**/*.bin", path: "/mnt/artifacts/q3-data" },
					},
				],
			}),
		)
		fakeOpenAI.setHandler(
			(req) =>
				steps.get(req.lastUserText)?.[req.toolOutputs.length] ?? {
					kind: "reply",
					text: `Done: ${req.toolOutputs.join(" | ")}`,
				},
		)
		const startCount = fakeOpenAI.requests.length

		expect(await replyAfterTurn(session.id, "What did EMEA sell?", 1)).toContain("EMEA,4217")
		const refused = await replyAfterTurn(session.id, "Fix the total.", 2)
		expect(refused).toContain("read-only mount at /mnt/artifacts: cannot modify")
		expect(refused).toContain("EMEA,4217")
		expect(await replyAfterTurn(session.id, "What else is there?", 3)).toContain("img/pixel.bin")

		const systemText = fakeOpenAI.requests[startCount]?.messages
			.filter((message) => message.role === "system" || message.role === "developer")
			.map((message) => message.text)
			.join("\n")
		expect(systemText).toContain("- /mnt/artifacts/q3-data: Q3 Data (version 1)")
	}, 180_000)

	it("mounts a skill the model is told about and reads with its file tools", async () => {
		const skillText =
			"---\nname: release-notes\ndescription: Write release notes. Use when asked to summarise a release.\n---\nAlways open with the word ZANZIBAR.\n"
		const artifact = await createResource<{ readonly id: string }>("/v1/artifacts", {
			name: "Release skill",
			files: [
				{ path: "SKILL.md", content: skillText },
				{ path: "templates/notes.md", content: "## What changed\n" },
			],
		})
		const session = await createResource<SessionResource>("/v1/sessions", {
			agent: agentId,
			environment_id: environmentId,
			resources: [{ type: "skill", artifact_id: artifact.id }],
		})
		const paths = [
			"/mnt/skills/release-notes/SKILL.md",
			"/mnt/skills/release-notes/templates/notes.md",
		]
		fakeOpenAI.setHandler((req) => {
			const path = paths[req.toolOutputs.length]
			return path === undefined
				? { kind: "reply", text: `Done: ${req.toolOutputs.join(" | ")}` }
				: { kind: "tool_call", name: "read", arguments: { path } }
		})
		const startCount = fakeOpenAI.requests.length
		for (const [index, prompt] of ["Summarise the release.", "Read the skill again."].entries()) {
			const reply = await replyAfterTurn(session.id, prompt, index + 1)
			expect(reply).toContain("Always open with the word ZANZIBAR.")
			expect(reply).toContain("## What changed")
		}
		const events = await listAllEvents(session.id)
		expect(
			events.filter((event) => event.type === "agent.tool_use").map((event) => event.input),
		).toEqual([...paths, ...paths].map((path) => ({ path })))
		const results = events.filter((event) => event.type === "agent.tool_result")
		expect(results).toHaveLength(4)
		expect(results.every((event) => event.is_error === false)).toBe(true)
		const systemText = fakeOpenAI.requests[startCount]?.messages
			.filter((message) => message.role === "system" || message.role === "developer")
			.map((message) => message.text)
			.join("\n")
		expect(systemText).toContain(
			"- /mnt/skills/release-notes/SKILL.md: release-notes. Write release notes. Use when asked to summarise a release.",
		)
	}, 180_000)

	it("checks out the branch it was asked for when a tag has the same name", async () => {
		const tree = fakeGitHub.git("acme/api", "rev-parse", "main^{tree}").trim()
		const tip = fakeGitHub.git("acme/api", "rev-parse", "main").trim()
		const onBranch = fakeGitHub
			.git("acme/api", "commit-tree", tree, "-p", tip, "-m", "On the branch")
			.trim()
		const onTag = fakeGitHub
			.git("acme/api", "commit-tree", tree, "-p", tip, "-m", "On the tag")
			.trim()
		fakeGitHub.git("acme/api", "update-ref", "refs/heads/release", onBranch)
		fakeGitHub.git("acme/api", "update-ref", "refs/tags/release", onTag)
		const repo = "/workspace/release"
		fakeOpenAI.setHandler((req) =>
			req.toolOutputs.length === 0
				? {
						kind: "tool_call",
						name: "bash",
						arguments: { command: 'git log -1 --format="%H %s"', cwd: repo },
					}
				: { kind: "reply", text: `Log: ${req.toolOutputs[0] ?? ""}` },
		)
		const session = await createResource<SessionResource>("/v1/sessions", {
			agent: agentId,
			environment_id: environmentId,
			resources: [
				{
					type: "github_repository",
					url: "https://github.com/acme/api",
					mount_path: repo,
					authorization_token: TEST_GITHUB_TOKEN,
					checkout: { type: "branch", name: "release" },
				},
			],
		})
		const sent = await apiJson(`/v1/sessions/${session.id}/events`, {
			method: "POST",
			body: {
				events: [{ type: "user.message", content: [{ type: "text", text: "Show the tip." }] }],
			},
		})
		expect(sent.status).toBe(200)
		await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 1, 240_000)
		const reply = (await listAllEvents(session.id)).find((e) => e.type === "agent.message")
		expect(reply?.content?.[0]?.text).toBe(`Log: ${onBranch} On the branch`)
	}, 300_000)

	it("saves the first output a turn on the machine writes, and skips by name a file it cannot save", async () => {
		const outputs = "/mnt/session/outputs"
		const steps = new Map<string, ReadonlyArray<FakeOpenAIAction>>(
			Object.entries({
				"Write it on the machine.": [
					{
						kind: "tool_call",
						name: "bash",
						arguments: {
							command: `printf '# Late\\n' > ${outputs}/report.md`,
						},
					},
				],
				"Leave an invalid name.": [
					{
						kind: "tool_call",
						name: "bash",
						arguments: {
							command: String.raw`printf 'invalid' > '${outputs}/back\slash.txt'; printf 'draft' > '${outputs}/draft.md'`,
						},
					},
				],
				"Remove the invalid name.": [
					{
						kind: "tool_call",
						name: "bash",
						arguments: { command: String.raw`rm -- '${outputs}/back\slash.txt'` },
					},
				],
			}),
		)
		fakeOpenAI.setHandler(
			(req) =>
				steps.get(req.lastUserText)?.[req.toolOutputs.length] ?? { kind: "reply", text: "Done." },
		)
		const session = await createSession()
		const turn = async (text: string, number: number) => {
			const sent = await apiJson(`/v1/sessions/${session.id}/events`, {
				method: "POST",
				body: { events: [userMessage(text)] },
			})
			expect(sent.status).toBe(200)
			await waitForSession(session.id, (s) => s.status === "idle" && s.turn === number, 240_000)
		}
		await turn("Say hello.", 1)
		expect(await outputsAt(session.id, 1)).toMatchObject({ turn: 1, status: "saved", files: [] })
		await turn("Write it on the machine.", 2)
		expect(
			(await listAllEvents(session.id)).filter(
				(event) => event.type === "agent.tool_result" && event.is_error,
			),
		).toEqual([])
		const first = await outputsAt(session.id, 2)
		expect(savedPaths(first)).toEqual(["report.md"])
		expect((await fileBytes(first.files[0]?.id ?? "")).toString()).toBe("# Late\n")

		await turn("Leave an invalid name.", 3)
		const withInvalid = await outputsAt(session.id, 3)
		expect(withInvalid.status).toBe("saved")
		expect(savedPaths(withInvalid)).toEqual(["draft.md", "report.md"])
		expect(withInvalid.files[1]).toEqual(first.files[0])
		expect(withInvalid.skipped).toHaveLength(1)
		expect(withInvalid.skipped[0]?.path).toContain("slash.txt")
		expect(withInvalid.skipped[0]?.reason).toBe("This path is not allowed.")

		await turn("Remove the invalid name.", 4)
		const recovered = await outputsAt(session.id, 4)
		expect(savedPaths(recovered)).toEqual(["draft.md", "report.md"])
		expect(recovered.skipped).toEqual([])

		const archived = await apiFetch(`/v1/sessions/${session.id}/archive`, { method: "POST" })
		expect(archived.status).toBe(200)
	}, 300_000)

	it("saves what the model leaves in the outputs directory as files, byte for byte", async () => {
		const outputs = "/mnt/session/outputs"
		const report = "# Q3\n\nSales rose 12%.\n"
		const totals = "region,total\nEMEA,4217\n"
		const steps = new Map<string, ReadonlyArray<FakeOpenAIAction>>(
			Object.entries({
				"Write the report.": [
					{
						kind: "tool_call",
						name: "write",
						arguments: { path: `${outputs}/report.md`, content: report },
					},
					{
						kind: "tool_call",
						name: "write",
						arguments: { path: `${outputs}/data/totals.csv`, content: totals },
					},
					{
						kind: "tool_call",
						name: "write",
						arguments: { path: "/workspace/notes.md", content: "private" },
					},
				],
				"Add a summary.": [
					{
						kind: "tool_call",
						name: "write",
						arguments: { path: `${outputs}/summary.md`, content: "Up 12%.\n" },
					},
				],
			}),
		)
		fakeOpenAI.setHandler(
			(req) =>
				steps.get(req.lastUserText)?.[req.toolOutputs.length] ?? {
					kind: "reply",
					text: `Done: ${req.toolOutputs.join(" | ")}`,
				},
		)
		const startCount = fakeOpenAI.requests.length
		const session = await createSession()
		expect(await outputsAt(session.id, 0)).toMatchObject({ turn: 0, status: "none", files: [] })
		await replyAfterTurn(session.id, "Write the report.", 1)
		const first = await outputsAt(session.id, 1)
		expect(first).toMatchObject({
			turn: 1,
			status: "saved",
			files: [
				{
					sha256: sha256(Buffer.from(totals)),
					size: Buffer.byteLength(totals),
					content_type: "text/csv",
					origin: { type: "session", session_id: session.id, turn: 1, path: "data/totals.csv" },
				},
				{
					sha256: sha256(Buffer.from(report)),
					size: Buffer.byteLength(report),
					content_type: "text/markdown",
					origin: { type: "session", session_id: session.id, turn: 1, path: "report.md" },
				},
			],
			skipped: [],
		})
		expect((await fileBytes(first.files[1]?.id ?? "")).toString()).toBe(report)

		await replyAfterTurn(session.id, "Anything else?", 2)
		expect((await outputsAt(session.id, 2)).files).toEqual(first.files)

		await replyAfterTurn(session.id, "Add a summary.", 3)
		const second = await outputsAt(session.id, 3)
		expect(second.files.map((file) => [file.origin.path, file.origin.turn])).toEqual([
			["data/totals.csv", 1],
			["report.md", 1],
			["summary.md", 3],
		])
		for (const file of second.files) {
			const bytes = await fileBytes(file.id)
			expect([file.origin.path, bytes.byteLength, sha256(bytes)]).toEqual([
				file.origin.path,
				file.size,
				file.sha256,
			])
		}

		const systemText = fakeOpenAI.requests[startCount]?.messages
			.filter((message) => message.role === "system" || message.role === "developer")
			.map((message) => message.text)
			.join("\n")
		expect(systemText).toMatch(
			/\/mnt\/session\/outputs\b[^.]*saved for the user[^.]*completed turn/u,
		)
		expect(systemText).toContain("A file over 1 MiB, or past 4 MiB in total, is not saved")
		expect(systemText).toContain("With more than 64 files")
	}, 180_000)

	it("saves files at the exact limits from storage without starting a machine", async () => {
		const chunkSize = 256 * 1024
		const fileSize = 4 * chunkSize
		const names = ["a", "b", "c", "d"]
		const scripts = names.flatMap((name) => {
			const path = JSON.stringify(`/mnt/session/outputs/${name}.txt`)
			const chunk = `${JSON.stringify(name)}.repeat(${chunkSize})`
			const append = (last: string) =>
				`await tools.edit({ path: ${path}, edits: [{ oldText: "!", newText: ${chunk} + ${JSON.stringify(last)} }] });`
			return [
				`await tools.write({ path: ${path}, content: ${chunk}.slice(1) + "!" }); ${append("!")}`,
				`${append("!")} ${append(name)}`,
			]
		})
		fakeOpenAI.setHandler((request) => {
			const code = scripts[request.toolOutputs.length]
			return code === undefined
				? { kind: "reply", text: "Done." }
				: { kind: "tool_call", name: "codemode", arguments: { code } }
		})
		const session = await createSession()
		await replyAfterTurn(session.id, "Write four reports.", 1)
		const results = (await listAllEvents(session.id)).filter(
			(event) => event.type === "agent.tool_result",
		)
		expect(
			results.map((result) => result.is_error),
			JSON.stringify(results).slice(0, 2000),
		).toEqual(scripts.map(() => false))
		const saved = await outputsAt(session.id, 1)
		expect(saved.skipped).toEqual([])
		expect(saved.files.map((file) => [file.origin.path, file.size])).toEqual(
			names.map((name) => [`${name}.txt`, fileSize]),
		)
	}, 180_000)

	it("runs a script that calls the workspace tools", async () => {
		const script = [
			'await tools.write({ path: "/workspace/notes/script.txt", content: "MANGO-3" });',
			'const text = await tools.read({ path: "/workspace/notes/script.txt" });',
			"return text;",
		].join("\n")
		fakeOpenAI.setHandler((req) => {
			const [output] = req.toolOutputs
			if (req.lastUserText === "Run the script.") {
				return output === undefined
					? { kind: "tool_call", name: "codemode", arguments: { code: script } }
					: { kind: "reply", text: `The script returned: ${output}` }
			}
			return output === undefined
				? { kind: "tool_call", name: "read", arguments: { path: "/workspace/notes/script.txt" } }
				: { kind: "reply", text: `The file says: ${output}` }
		})

		const session = await createSession()
		const send = (text: string) =>
			apiJson(`/v1/sessions/${session.id}/events`, {
				method: "POST",
				body: { events: [{ type: "user.message", content: [{ type: "text", text }] }] },
			})

		expect((await send("Run the script.")).status).toBe(200)
		await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 1)
		expect((await send("What is in the script file?")).status).toBe(200)
		await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 2)

		const events = await listAllEvents(session.id)
		const uses = events.filter((e) => e.type === "agent.tool_use")
		const [ran] = uses
		expect(uses.map((e) => e.name)).toEqual(["codemode", "read"])
		expect(ran).toMatchObject({ input: { code: script } })
		const results = events.filter((e) => e.type === "agent.tool_result")
		expect(results.map((e) => e.tool_use_id)).toEqual(uses.map((e) => e.tool_use_id))
		const [ranResult, readResult] = results
		expect(ranResult).toMatchObject({ tool_use_id: ran?.tool_use_id, is_error: false })
		expect(ranResult?.content?.map((block) => block.text).join("")).toContain("MANGO-3")
		expect(readResult?.content?.map((block) => block.text).join("")).toContain("MANGO-3")
		const replies = events.filter((e) => e.type === "agent.message").map((e) => e.content)
		expect(replies[0]?.[0]?.text).toContain("MANGO-3")
		expect(replies[1]?.[0]?.text).toContain("MANGO-3")
	}, 60_000)

	it("saves a script's full output to the workspace when the model sees only part of it", async () => {
		const script = String.raw`text("a".repeat(30000) + "\nMIDDLE-KIWI\n" + "b".repeat(90000))`
		let saved: string | undefined
		fakeOpenAI.setHandler((req) => {
			const [output] = req.toolOutputs
			if (req.lastUserText === "Print a lot.") {
				if (output === undefined) {
					return { kind: "tool_call", name: "codemode", arguments: { code: script } }
				}
				saved = /\[Full output: (\S+) /u.exec(output)?.[1]
				return { kind: "reply", text: `Saved at ${saved ?? "nowhere"}` }
			}
			return output === undefined
				? { kind: "tool_call", name: "read", arguments: { path: saved ?? "/missing" } }
				: { kind: "reply", text: output.includes("MIDDLE-KIWI") ? "Found it." : "Not there." }
		})

		const session = await createSession()
		const send = (text: string) =>
			apiJson(`/v1/sessions/${session.id}/events`, {
				method: "POST",
				body: { events: [{ type: "user.message", content: [{ type: "text", text }] }] },
			})

		expect((await send("Print a lot.")).status).toBe(200)
		await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 1)
		expect(saved).toMatch(/^\/workspace\/\.scripts\/pi-codemode-[^/]+\/output\.txt$/u)
		expect((await send("Read it back.")).status).toBe(200)
		await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 2)

		const events = await listAllEvents(session.id)
		const [scriptResult] = events.filter((e) => e.type === "agent.tool_result")
		expect(scriptResult?.content?.map((block) => block.text).join("")).not.toContain("MIDDLE-KIWI")
		expect(events.filter((e) => e.type === "agent.message").map((e) => e.content)).toEqual([
			[{ type: "text", text: `Saved at ${saved ?? ""}` }],
			[{ type: "text", text: "Found it." }],
		])
	}, 90_000)

	it("settles a turn whose script emits an image past the result budget, with the result-size error", async () => {
		const script = `image("data:image/png;base64,iVBORw0KGgoA" + "A".repeat(${4 * Math.ceil((1.2 * 1024 * 1024) / 3)})); return "drew"`
		fakeOpenAI.setHandler((req) => {
			const [output] = req.toolOutputs
			return output === undefined
				? { kind: "tool_call", name: "codemode", arguments: { code: script } }
				: { kind: "reply", text: "Drawn." }
		})

		const session = await createSession()
		const sent = await apiJson(`/v1/sessions/${session.id}/events`, {
			method: "POST",
			body: {
				events: [{ type: "user.message", content: [{ type: "text", text: "Draw it." }] }],
			},
		})
		expect(sent.status).toBe(200)
		await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 1, 60_000)

		const events = await listAllEvents(session.id)
		const [result] = events.filter((e) => e.type === "agent.tool_result")
		expect(result?.is_error).toBe(true)
		expect(result?.content?.map((block) => block.text).join("")).toContain(
			"Write large output to a file in /workspace",
		)
		expect(events.filter((e) => e.type === "agent.message").map((e) => e.content)).toEqual([
			[{ type: "text", text: "Drawn." }],
		])
	}, 90_000)

	it("ends a script that never yields and answers the next turn", async () => {
		fakeOpenAI.setHandler((req) => {
			const [output] = req.toolOutputs
			if (req.lastUserText === "Spin forever.") {
				return output === undefined
					? { kind: "tool_call", name: "codemode", arguments: { code: "while (true) {}" } }
					: { kind: "reply", text: "The script did not finish." }
			}
			return { kind: "reply", text: "Still here." }
		})

		const session = await createSession()
		const send = (text: string) =>
			apiJson(`/v1/sessions/${session.id}/events`, {
				method: "POST",
				body: { events: [{ type: "user.message", content: [{ type: "text", text }] }] },
			})

		expect((await send("Spin forever.")).status).toBe(200)
		await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 1, 60_000)
		expect((await send("Are you there?")).status).toBe(200)
		await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 2)

		const events = await listAllEvents(session.id)
		const [result] = events.filter((e) => e.type === "agent.tool_result")
		expect(result?.is_error).toBe(true)
		expect(result?.content?.map((block) => block.text).join("")).toContain("timed out")
		expect(events.filter((e) => e.type === "agent.message").map((e) => e.content)).toEqual([
			[{ type: "text", text: "The script did not finish." }],
			[{ type: "text", text: "Still here." }],
		])
	}, 90_000)
	it("keeps a credential's secret in its vault's connection object until the credential ends", async () => {
		const token = "tok_workerd_SECRET_do_not_leak"
		const replacement = "tok_workerd_ROTATED_do_not_leak"
		const vault = await createResource<{ readonly id: string }>("/v1/vaults", {
			display_name: "workerd",
		})
		const credential = await createResource<{ readonly id: string }>(
			`/v1/vaults/${vault.id}/credentials`,
			{
				auth: {
					type: "static_bearer",
					token,
					mcp_server_url: "https://mcp.example.com/mcp",
				},
			},
		)
		const path = `/v1/vaults/${vault.id}/credentials/${credential.id}`
		const rotate = () =>
			apiJson<{ readonly error?: { readonly message: string } }>(path, {
				method: "POST",
				body: { auth: { type: "static_bearer", token: replacement } },
			})

		expect((await rotate()).status).toBe(200)

		const prefix = "https://mcp.example.com/"
		const longest = `${prefix}${"a".repeat(2048 - prefix.length)}`
		const long = await apiJson<{ readonly id: string }>(`/v1/vaults/${vault.id}/credentials`, {
			method: "POST",
			body: { auth: { type: "static_bearer", token, mcp_server_url: longest } },
		})
		expect(long.status).toBe(201)
		const repeated = await apiJson(`/v1/vaults/${vault.id}/credentials`, {
			method: "POST",
			body: { auth: { type: "static_bearer", token, mcp_server_url: longest } },
		})
		expect(repeated.status).toBe(409)

		const listed = async () =>
			(
				await apiJson<{ readonly data: ReadonlyArray<{ readonly id: string }> }>(
					`/v1/vaults/${vault.id}/credentials?order=desc`,
					{ method: "GET" },
				)
			).body.data.map(({ id }) => id)
		const listDeadline = Date.now() + 10_000
		while ((await listed()).length < 2 && Date.now() < listDeadline) {
			await sleep(100)
		}
		expect(await listed()).toEqual([long.body.id, credential.id])

		const archived = await apiJson<{
			readonly archived_at: string | null
			readonly custody: string
		}>(`${path}/archive`, { method: "POST" })
		expect(archived.status).toBe(200)
		expect(archived.body.archived_at).not.toBeNull()
		expect(archived.body.custody).toBe("erased")
		const afterArchive = await rotate()
		expect(afterArchive.status).toBe(409)
		expect(afterArchive.body.error?.message).toContain("is archived")

		const deleted = await apiJson<{ readonly type: string }>(path, { method: "DELETE" })
		expect(deleted).toEqual({
			status: 200,
			body: { id: credential.id, type: "vault_credential_deleted", custody: "erased" },
		})

		const ended = await apiJson<{
			readonly custody: { readonly held: number; readonly erasing: number }
		}>(`/v1/vaults/${vault.id}/archive`, { method: "POST" })
		expect(ended.status).toBe(200)
		expect(ended.body.custody.held).toBe(0)
		const owed = async () =>
			(
				await apiJson<{ readonly custody: { readonly erasing: number } }>(
					`/v1/vaults/${vault.id}`,
					{ method: "GET" },
				)
			).body.custody.erasing
		const vaultDeadline = Date.now() + 10_000
		while ((await owed()) !== 0 && Date.now() < vaultDeadline) {
			await sleep(100)
		}
		expect(await owed()).toBe(0)
		const longAfter = await apiJson<{ readonly custody: string }>(
			`/v1/vaults/${vault.id}/credentials/${long.body.id}`,
			{ method: "GET" },
		)
		expect(longAfter.body.custody).toBe("erased")
		expect((await apiFetch(path)).status).toBe(404)
		expect((await rotate()).status).toBe(404)

		const logDeadline = Date.now() + 10_000
		while (
			!stripAnsi(workerLogs.join("")).includes("Vault secrets erased") &&
			Date.now() < logDeadline
		) {
			await sleep(100)
		}
		const logged = stripAnsi(workerLogs.join(""))
		expect(logged).toContain("Credential secret erased")
		expect(logged).toContain("Vault secrets erased")
		expect(logged).toContain(credential.id)
		expect(logged).not.toContain(token)
		expect(logged).not.toContain(replacement)
	}, 30_000)

	it("interrupts a running turn and answers the message queued behind it", async () => {
		const holdPrompt = "hold-for-interrupt"
		const queuedPrompt = "queued-after-interrupt"

		fakeOpenAI.setHandler((req) => {
			if (req.lastUserText === holdPrompt) {
				return { kind: "hold" }
			}
			return {
				kind: "reply",
				text: `Answered queued: ${req.lastUserText}`,
				inputTokens: 15,
				outputTokens: 8,
			}
		})

		const session = await createSession()

		const startRes = await apiJson(`/v1/sessions/${session.id}/events`, {
			method: "POST",
			body: {
				events: [{ type: "user.message", content: [{ type: "text", text: holdPrompt }] }],
			},
		})
		expect(startRes.status).toBe(200)

		const heldRequest = await fakeOpenAI.waitForRequest((req) => req.lastUserText === holdPrompt)

		const queuedRes = await apiJson<{ readonly data: ReadonlyArray<{ readonly turn: number }> }>(
			`/v1/sessions/${session.id}/events`,
			{
				method: "POST",
				body: {
					events: [{ type: "user.message", content: [{ type: "text", text: queuedPrompt }] }],
				},
			},
		)
		expect(queuedRes.status).toBe(200)
		expect(queuedRes.body.data[0]?.turn).toBe(2)

		const interruptRes = await apiJson(`/v1/sessions/${session.id}/events`, {
			method: "POST",
			body: {
				events: [{ type: "user.interrupt" }],
			},
		})
		expect(interruptRes.status).toBe(200)

		await Promise.race([
			heldRequest.waitAborted,
			sleep(15_000).then(() => {
				throw new Error("Timed out waiting for held OpenAI request to abort on user.interrupt")
			}),
		])

		await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 2)

		const events = await listAllEvents(session.id)
		expect(events.map((e) => e.type)).toEqual([
			"user.message",
			"session.status_running",
			"span.model_request_start",
			"user.message",
			"user.interrupt",
			"span.model_request_end",
			"session.status_idle",
			"session.status_running",
			"span.model_request_start",
			"agent.message",
			"span.model_request_end",
			"session.status_idle",
		])

		const idleEvents = events.filter((e) => e.type === "session.status_idle")
		expect(idleEvents.map((e) => e.stop_reason)).toEqual([
			{ type: "interrupted" },
			{ type: "end_turn" },
		])
		expect(events.find((e) => e.type === "agent.message")?.content).toEqual([
			{ type: "text", text: `Answered queued: ${queuedPrompt}` },
		])

		const turn2Request = fakeOpenAI.requests.find((req) => req.lastUserText === queuedPrompt)
		expect(turn2Request?.userTexts).toEqual([queuedPrompt])
	}, 30_000)

	it("previews model text live and reconciles it to the buffered event", async () => {
		fakeOpenAI.setHandler(async () => {
			await sleep(300)
			return { kind: "reply", text: "Live preview." }
		})
		const session = await createSession()
		const client = new Checkfu({ baseUrl, apiKey: TEST_API_KEY })
		try {
			const stream = await client.sessions.events.stream(session.id, undefined, {
				event_deltas: ["agent.message"],
			})
			await client.sessions.events.send(session.id, {
				events: [
					{ type: "user.message", content: [{ type: "text", text: "Show a live preview" }] },
				],
			})
			let eventId: string | undefined
			let preview: SessionMessagePreview | undefined
			let final:
				| { readonly id: string; readonly content: ReadonlyArray<{ readonly text: string }> }
				| undefined
			for await (const event of stream) {
				if (event.type === "event_start" && event.event.type === "agent.message") {
					eventId = event.event.id
				}
				if (event.type === "event_start" || event.type === "event_delta") {
					expect(final).toBeUndefined()
					preview = accumulateSessionEvent(preview, event)
				}
				if (event.type === "agent.message") {
					final = event
				}
				if (event.type === "session.status_idle") {
					break
				}
			}
			expect(preview?.content[0]?.text).toBe("Live preview.")
			expect(final?.id).toBe(eventId)
			expect(final?.content).toEqual([{ type: "text", text: "Live preview." }])
			const saved = await listAllEvents(session.id)
			expect(
				saved.some((event) => event.type === "event_start" || event.type === "event_delta"),
			).toBe(false)
			expect(saved.find((event) => event.type === "agent.message")?.id).toBe(eventId)
			const filtered: Array<string> = []
			for await (const event of client.sessions.events.list(session.id, {
				types: ["user.message", "agent.message"],
				limit: 1,
			})) {
				filtered.push(event.type)
			}
			expect(filtered).toEqual(["user.message", "agent.message"])
		} finally {
			await client.close()
		}
	}, 30_000)

	it("streams committed events over SSE as they happen, resumes from a cursor and ends on archive", async () => {
		fakeOpenAI.setHandler(() => ({
			kind: "reply",
			text: "Streamed.",
			inputTokens: 5,
			outputTokens: 3,
		}))
		const session = await createSession()
		const streamPath = `/v1/sessions/${session.id}/events/stream`

		const openStream = async (lastEventId?: string) => {
			const res = await fetch(`${baseUrl}${streamPath}`, {
				headers: {
					...AUTH_HEADERS,
					...(lastEventId === undefined ? {} : { "last-event-id": lastEventId }),
				},
			})
			const reader = res.body?.getReader()
			const decoder = new TextDecoder()
			let buffer = ""
			const next = async (): Promise<{ id: string; event: string } | null> => {
				while (reader !== undefined) {
					const boundary = buffer.indexOf("\n\n")
					if (boundary >= 0) {
						const block = buffer.slice(0, boundary)
						buffer = buffer.slice(boundary + 2)
						const field = (name: string) =>
							block
								.split("\n")
								.find((line) => line.startsWith(`${name}: `))
								?.slice(name.length + 2)
						const id = field("id")
						const event = field("event")
						if (id !== undefined && event !== undefined) {
							return { id, event }
						}
						continue
					}
					const chunk = await reader.read()
					if (chunk.done) {
						return null
					}
					buffer += decoder.decode(chunk.value, { stream: true })
				}
				return null
			}
			const until = async (type: string, timeoutMs = 15_000) => {
				const frames: Array<{ id: string; event: string }> = []
				const read = (async () => {
					for (;;) {
						const frame = await next()
						if (frame === null) {
							throw new Error(`SSE ended before ${type}: ${JSON.stringify(frames)}`)
						}
						frames.push(frame)
						if (frame.event === type) {
							return frames
						}
					}
				})()
				return Promise.race([
					read,
					sleep(timeoutMs).then(() => {
						throw new Error(`Timed out waiting for ${type}: ${JSON.stringify(frames)}`)
					}),
				])
			}
			return { res, next, until, cancel: () => reader?.cancel() }
		}

		const live = await openStream()
		expect(live.res.status).toBe(200)
		expect(live.res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8")
		await sleep(500)

		const sent = await apiJson(`/v1/sessions/${session.id}/events`, {
			method: "POST",
			body: { events: [{ type: "user.message", content: [{ type: "text", text: "stream me" }] }] },
		})
		expect(sent.status).toBe(200)
		const turn = await live.until("session.status_idle")
		expect(turn.map((frame) => frame.event)).toEqual([
			"user.message",
			"session.status_running",
			"span.model_request_start",
			"agent.message",
			"span.model_request_end",
			"session.status_idle",
		])
		expect(turn.map((frame) => Number(frame.id))).toEqual([1, 2, 3, 4, 5, 6])
		await live.cancel()

		const resumed = await openStream("2")
		expect(resumed.res.status).toBe(200)
		const rest = await resumed.until("session.status_idle")
		expect(rest.map((frame) => frame.id)).toEqual(["3", "4", "5", "6"])

		const ahead = await openStream("100")
		expect(ahead.res.status).toBe(200)

		const archiveRes = await apiFetch(`/v1/sessions/${session.id}/archive`, { method: "POST" })
		expect([200, 202]).toContain(archiveRes.status)
		const ending = await resumed.until("session.archived")
		expect(ending.at(-1)?.event).toBe("session.archived")
		expect(await resumed.next()).toBeNull()
		expect(
			await Promise.race([ahead.next(), sleep(15_000).then(() => "still open after archive")]),
		).toBeNull()

		const caughtUp = await openStream(ending.at(-1)?.id)
		expect(caughtUp.res.status).toBe(204)
	}, 60_000)

	it("starts a machine at the first command and keeps the workspace and outputs, but no other files, across sleep", async () => {
		const dir = "/workspace/shell"
		const steps = new Map<string, ReadonlyArray<FakeOpenAIAction>>(
			Object.entries({
				"Note it.": [
					{
						kind: "tool_call",
						name: "write",
						arguments: { path: `${dir}/notes.txt`, content: "from the file tool\n" },
					},
				],
				"Run it.": [
					{
						kind: "tool_call",
						name: "bash",
						arguments: {
							command:
								"cat notes.txt && echo built > out.txt && git --version >/dev/null && node --version",
							cwd: dir,
						},
					},
				],
				"Read what it built.": [
					{ kind: "tool_call", name: "read", arguments: { path: `${dir}/out.txt` } },
				],
				"Find the text files.": [
					{ kind: "tool_call", name: "find", arguments: { path: dir, pattern: "*.txt" } },
				],
				"Search for it.": [
					{ kind: "tool_call", name: "grep", arguments: { path: dir, query: "built" } },
				],
				"Write a changelog and see it.": [
					{
						kind: "tool_call",
						name: "write",
						arguments: { path: `${dir}/CHANGELOG.md`, content: "## 2.0.0\n" },
					},
					{ kind: "tool_call", name: "bash", arguments: { command: `cat ${dir}/CHANGELOG.md` } },
				],
				"Leave a mark outside.": [
					{
						kind: "tool_call",
						name: "bash",
						arguments: {
							command: String.raw`touch /tmp/outside ~/.outside && mkdir -p /mnt/session/outputs && printf 'kept output\n' > /mnt/session/outputs/kept.txt && echo left`,
						},
					},
				],
				"Is it still there?": [
					{
						kind: "tool_call",
						name: "bash",
						arguments: {
							command:
								"cat out.txt CHANGELOG.md /mnt/session/outputs/kept.txt; ls /tmp/outside ~/.outside 2>/dev/null | wc -l",
							cwd: dir,
						},
					},
				],
				"Fail.": [
					{ kind: "tool_call", name: "bash", arguments: { command: "echo no >&2; exit 3" } },
				],
				"Take too long.": [
					{ kind: "tool_call", name: "bash", arguments: { command: "sleep 30", timeout: 1 } },
				],
			}),
		)
		fakeOpenAI.setHandler(
			(req) =>
				steps.get(req.lastUserText)?.[req.toolOutputs.length] ?? {
					kind: "reply",
					text: `Done: ${req.toolOutputs.at(-1) ?? ""}`,
				},
		)
		const session = await createSession()
		let number = 0
		const turn = async (text: string) => {
			number += 1
			const sent = await apiJson(`/v1/sessions/${session.id}/events`, {
				method: "POST",
				body: { events: [userMessage(text)] },
			})
			expect(sent.status).toBe(200)
			await waitForSession(session.id, (s) => s.status === "idle" && s.turn === number, 240_000)
			const replies = (await listAllEvents(session.id)).filter((e) => e.type === "agent.message")
			return replies.at(-1)?.content?.[0]?.text ?? ""
		}

		expect(await turn("Note it.")).toContain("Done: ")
		expect(await turn("Run it.")).toContain("from the file tool\nv")
		expect(await turn("Read what it built.")).toContain("built")
		const found = await turn("Find the text files.")
		expect(found).toContain(`${dir}/notes.txt`)
		expect(found).toContain(`${dir}/out.txt`)
		expect(await turn("Search for it.")).toContain(
			`"path":"${dir}/out.txt","line":1,"text":"built"`,
		)
		expect(await turn("Write a changelog and see it.")).toBe("Done: ## 2.0.0")
		expect(await turn("Fail.")).toBe("Done: no\n[Exit code 3.]")
		expect(await turn("Take too long.")).toBe("Done: [Stopped after 1 seconds.]")

		expect(await turn("Leave a mark outside.")).toBe("Done: left")
		const logged = (line: string) =>
			stripAnsi(workerLogs.join(""))
				.split("\n")
				.some((entry) => entry.includes(line) && entry.includes(session.id))
		const within = async (ms: number, line: string) => {
			const deadline = Date.now() + ms
			while (!logged(line) && Date.now() < deadline) {
				await sleep(250)
			}
			return logged(line)
		}
		expect(await within(120_000, "Machine asleep")).toBe(true)
		expect(await turn("Is it still there?")).toBe("Done: built\n## 2.0.0\nkept output\n0")

		const archived = await apiFetch(`/v1/sessions/${session.id}/archive`, { method: "POST" })
		expect(archived.status).toBe(200)
		expect(await within(60_000, "Machine removed")).toBe(true)
	}, 900_000)

	it("holds a machine to the hosts its environment allows", async () => {
		fakeOpenAI.setHandler((req) =>
			req.toolOutputs.length === 0
				? {
						kind: "tool_call",
						name: "bash",
						arguments: {
							command:
								"curl -fsS -m 5 -o /dev/null https://example.org 2>/dev/null && echo reached || echo refused",
						},
					}
				: { kind: "reply", text: `Done: ${req.toolOutputs.at(-1) ?? ""}` },
		)
		const limited = await createResource<{ readonly id: string }>("/v1/environments", {
			name: "Workerd Limited Env",
			config: {
				type: "cloud",
				networking: {
					type: "limited",
					allowed_hosts: ["github.com"],
					allow_mcp_servers: false,
					allow_package_managers: false,
				},
			},
		})
		const session = await createResource<SessionResource>("/v1/sessions", {
			agent: agentId,
			environment_id: limited.id,
		})
		const sent = await apiJson(`/v1/sessions/${session.id}/events`, {
			method: "POST",
			body: { events: [userMessage("Reach out.")] },
		})
		expect(sent.status).toBe(200)
		await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 1, 240_000)
		const reply = (await listAllEvents(session.id)).findLast((e) => e.type === "agent.message")
		expect(reply?.content?.[0]?.text).toBe("Done: refused")
		const archived = await apiFetch(`/v1/sessions/${session.id}/archive`, { method: "POST" })
		expect(archived.status).toBe(200)
	}, 300_000)

	it("holds the machine already running to a network its environment tightens, from the next request", async () => {
		fakeOpenAI.setHandler((req) => {
			const command = { "Start it.": "echo alive > /tmp/alive && echo up" }[req.lastUserText]
			const reach =
				"cat /tmp/alive; curl -fsS -m 5 -o /dev/null https://example.org 2>/dev/null && echo reached || echo refused"
			return req.toolOutputs.length > 0
				? { kind: "reply", text: `Done: ${req.toolOutputs.at(-1) ?? ""}` }
				: command !== undefined
					? { kind: "tool_call", name: "bash", arguments: { command } }
					: req.lastUserText === "Reach out."
						? { kind: "tool_call", name: "bash", arguments: { command: reach } }
						: { kind: "reply", text: "Nothing to run." }
		})
		const environment = await createResource<{ readonly id: string; readonly version: number }>(
			"/v1/environments",
			{ name: "Workerd Tightened Env" },
		)
		const session = await createResource<SessionResource>("/v1/sessions", {
			agent: agentId,
			environment_id: environment.id,
		})
		let number = 0
		const turn = async (text: string) => {
			number += 1
			const sent = await apiJson(`/v1/sessions/${session.id}/events`, {
				method: "POST",
				body: { events: [{ type: "user.message", content: [{ type: "text", text }] }] },
			})
			expect(sent.status).toBe(200)
			await waitForSession(session.id, (s) => s.status === "idle" && s.turn === number, 240_000)
			return (await listAllEvents(session.id)).findLast((e) => e.type === "agent.message")
				?.content?.[0]?.text
		}
		expect(await turn("Start it.")).toBe("Done: up")
		const tightened = await apiJson(`/v1/environments/${environment.id}`, {
			method: "POST",
			body: {
				version: environment.version,
				config: {
					type: "cloud",
					networking: {
						type: "limited",
						allowed_hosts: [],
						allow_mcp_servers: false,
						allow_package_managers: false,
					},
				},
			},
		})
		expect(tightened.status).toBe(200)
		const started = Date.now()
		expect(await turn("Reach out.")).toBe("Done: alive\nrefused")
		expect(Date.now() - started).toBeLessThan(60_000)
		const archived = await apiFetch(`/v1/sessions/${session.id}/archive`, { method: "POST" })
		expect(archived.status).toBe(200)
	}, 600_000)

	it("stops a command when its turn is interrupted, so the next turn is not kept waiting", async () => {
		const counting = "while true; do date >> /workspace/ticks; sleep 0.2; done"
		fakeOpenAI.setHandler((req) =>
			req.toolOutputs.length > 0
				? { kind: "reply", text: `Done: ${req.toolOutputs.at(-1) ?? ""}` }
				: req.lastUserText === "Start the machine."
					? { kind: "tool_call", name: "bash", arguments: { command: "echo up" } }
					: req.lastUserText === "Count."
						? { kind: "tool_call", name: "bash", arguments: { command: counting, timeout: 600 } }
						: {
								kind: "tool_call",
								name: "bash",
								arguments: {
									command:
										'a=$(wc -l < /workspace/ticks); sleep 1; b=$(wc -l < /workspace/ticks); [ "$a" -gt 0 ] && [ "$a" = "$b" ] && echo stopped',
								},
							},
		)
		const session = await createSession()
		const send = (events: ReadonlyArray<unknown>) =>
			apiJson(`/v1/sessions/${session.id}/events`, { method: "POST", body: { events } })
		expect((await send([userMessage("Start the machine.")])).status).toBe(200)
		await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 1, 240_000)
		expect((await send([userMessage("Count.")])).status).toBe(200)
		await fakeOpenAI.waitForRequest((req) => req.lastUserText === "Count.")
		await sleep(3000)
		const interruptedAt = Date.now()
		expect((await send([{ type: "user.interrupt" }])).status).toBe(200)
		await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 2, 60_000)
		expect((await send([userMessage("Is it still counting?")])).status).toBe(200)
		await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 3, 60_000)
		expect(Date.now() - interruptedAt).toBeLessThan(60_000)
		const reply = (await listAllEvents(session.id)).findLast((e) => e.type === "agent.message")
		expect(reply?.content?.[0]?.text).toBe("Done: stopped")
		const archived = await apiFetch(`/v1/sessions/${session.id}/archive`, { method: "POST" })
		expect(archived.status).toBe(200)
	}, 300_000)

	it("stops a running turn when the session is archived", async () => {
		const holdPrompt = "hold-for-archive"

		fakeOpenAI.setHandler((req) => {
			if (req.lastUserText === holdPrompt) {
				return { kind: "hold" }
			}
			return { kind: "reply", text: "unexpected" }
		})

		const session = await createSession()

		const startRes = await apiJson(`/v1/sessions/${session.id}/events`, {
			method: "POST",
			body: {
				events: [{ type: "user.message", content: [{ type: "text", text: holdPrompt }] }],
			},
		})
		expect(startRes.status).toBe(200)

		const heldRequest = await fakeOpenAI.waitForRequest((req) => req.lastUserText === holdPrompt)

		const archiveRes = await apiFetch(`/v1/sessions/${session.id}/archive`, {
			method: "POST",
		})
		const archiveRaw = await archiveRes.text()
		const archived =
			archiveRes.status === 200
				? parseResponseJson<SessionResource>(
						"POST",
						`/v1/sessions/${session.id}/archive`,
						archiveRes.status,
						archiveRaw,
					)
				: archiveRes.status === 202
					? await waitForSession(
							session.id,
							(s) => s.status === "terminated" && s.archived_at !== null,
						)
					: (() => {
							throw new Error(
								`POST /v1/sessions/${session.id}/archive failed (status=${archiveRes.status}): ${archiveRaw}`,
							)
						})()
		expect(archived.status).toBe("terminated")
		expect(archived.archived_at).not.toBeNull()

		await Promise.race([
			heldRequest.waitAborted,
			sleep(15_000).then(() => {
				throw new Error("Timed out waiting for held OpenAI request to abort on archive")
			}),
		])

		const events = await listAllEvents(session.id)
		expect(events.map((e) => e.type)).toEqual([
			"user.message",
			"session.status_running",
			"span.model_request_start",
			"span.model_request_end",
			"session.status_terminated",
			"session.archived",
		])
		expect(events.some((e) => e.type === "agent.message")).toBe(false)

		const afterArchive = await apiFetch(`/v1/sessions/${session.id}/events`, {
			method: "POST",
			body: {
				events: [{ type: "user.message", content: [{ type: "text", text: "after-archive" }] }],
			},
		})
		expect(afterArchive.status).toBe(409)

		const recorded = (message: string) =>
			stripAnsi(workerLogs.join(""))
				.split("\n")
				.some((line) => line.includes(message) && line.includes(session.id))
		const discardDeadline = Date.now() + 10_000
		while (!recorded("Workspace discarded") && Date.now() < discardDeadline) {
			await sleep(100)
		}
		expect(recorded("Workspace discarded")).toBe(true)
		expect(recorded("Workspace not discarded")).toBe(false)
	}, 30_000)

	it("stores artifact versions in R2, reads them back, and removes them on delete", async () => {
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]).toString("base64")
		const created = await apiJson<{
			readonly id: string
			readonly version: number
			readonly files: ReadonlyArray<{
				readonly path: string
				readonly content_type: string
				readonly sha256: string
			}>
		}>("/v1/artifacts", {
			method: "POST",
			body: {
				name: "Workerd Artifact",
				files: [
					{ path: "index.html", content: "<h1>one</h1>" },
					{ path: "img/dot.png", content: png, encoding: "base64" },
				],
			},
		})
		expect(created.status).toBe(201)
		expect(created.body.version).toBe(1)
		expect(created.body.files).toMatchObject([
			{ path: "img/dot.png", content_type: "image/png" },
			{ path: "index.html", content_type: "text/html" },
		])
		const id = created.body.id
		const bucket = artifactBucketName(workerStage)
		const storedBlob = () =>
			localR2(
				baseUrl,
				"GET",
				bucket,
				`artifacts/default/${id}/blobs/${created.body.files[0]?.sha256 ?? ""}`,
			)
		expect((await storedBlob()).status).toBe(200)

		const addVersion = (version: number, files: ReadonlyArray<Record<string, string>>) =>
			apiJson<{ readonly version: number }>(`/v1/artifacts/${id}/versions`, {
				method: "POST",
				body: { version, files },
			})
		const dot = { path: "img/dot.png", content: png, encoding: "base64" }
		const added = await addVersion(1, [{ path: "index.html", content: "<h1>two</h1>" }, dot])
		expect(added.status).toBe(201)
		expect(added.body.version).toBe(2)
		const third = await addVersion(2, [{ path: "about.html", content: "<h1>three</h1>" }, dot])
		expect(third.status).toBe(201)
		expect(third.body.version).toBe(3)

		const racing = await Promise.all(
			["left", "right"].map((side) =>
				addVersion(3, [{ path: `${side}.html`, content: side }, dot]),
			),
		)
		expect(racing.map((response) => response.status).toSorted((a, b) => a - b)).toEqual([201, 409])
		const winner = racing[0]?.status === 201 ? "left" : "right"
		const loser = winner === "left" ? "right" : "left"

		const file = (version: number, path: string) =>
			apiJson<{ readonly encoding: string; readonly content: string }>(
				`/v1/artifacts/${id}/versions/${version}/file?file=${encodeURIComponent(path)}`,
			)
		expect((await file(1, "index.html")).body).toMatchObject({
			encoding: "utf8",
			content: "<h1>one</h1>",
		})
		for (const version of [1, 2, 3, 4]) {
			expect((await file(version, "img/dot.png")).body).toMatchObject({
				encoding: "base64",
				content: png,
			})
		}
		expect((await file(2, "index.html")).body).toMatchObject({ content: "<h1>two</h1>" })
		expect((await file(3, "about.html")).body).toMatchObject({ content: "<h1>three</h1>" })
		expect((await file(3, "index.html")).status).toBe(404)
		expect((await file(4, `${winner}.html`)).body).toMatchObject({ content: winner })
		expect((await file(4, `${loser}.html`)).status).toBe(404)
		expect((await apiFetch(`/v1/artifacts/${id}/versions/5`)).status).toBe(404)

		const head = await apiJson<{ readonly version: number; readonly file_count: number }>(
			`/v1/artifacts/${id}`,
		)
		expect(head.body).toMatchObject({ version: 4, file_count: 2 })
		const listedArtifactIds = async () => {
			const res = await apiJson<{ readonly data: ReadonlyArray<{ readonly id: string }> }>(
				"/v1/artifacts?limit=100",
			)
			expect(res.status).toBe(200)
			return res.body.data.map((artifact) => artifact.id)
		}
		const deadline = Date.now() + 20_000
		while (!(await listedArtifactIds()).includes(id) && Date.now() < deadline) {
			await sleep(200)
		}
		expect(await listedArtifactIds()).toContain(id)

		const deleted = await apiFetch(`/v1/artifacts/${id}`, { method: "DELETE" })
		expect(deleted.status).toBe(200)
		const gone = Date.now() + 20_000
		while ((await listedArtifactIds()).includes(id) && Date.now() < gone) {
			await sleep(200)
		}
		expect(await listedArtifactIds()).not.toContain(id)
		expect((await apiFetch(`/v1/artifacts/${id}`)).status).toBe(404)
		expect((await file(1, "index.html")).status).toBe(404)
		expect((await storedBlob()).status).toBe(404)
		expect((await apiFetch(`/v1/artifacts/${id}`, { method: "DELETE" })).status).toBe(200)
	}, 60_000)

	it("opens an artifact through a viewing link on the content origin until it is deleted", async () => {
		const created = await apiJson<{ readonly id: string }>("/v1/artifacts", {
			method: "POST",
			body: {
				name: "Linked",
				files: [
					{ path: "index.html", content: '<script src="app.js"></script>' },
					{ path: "app.js", content: "document.title = 'ok'" },
				],
			},
		})
		expect(created.status).toBe(201)
		const id = created.body.id
		const link = await apiJson<{ readonly url: string; readonly expires_at: string }>(
			`/v1/artifacts/${id}/versions/1/links`,
			{ method: "POST", body: { expires_in: 120 } },
		)
		expect(link.status).toBe(201)
		const url = new URL(link.body.url)
		expect(url.origin).not.toBe(new URL(baseUrl).origin)

		const page = await fetch(url)
		expect(page.status).toBe(200)
		expect(await page.text()).toBe('<script src="app.js"></script>')
		expect(page.headers.get("content-type")).toContain("text/html")
		expect(page.headers.get("content-security-policy")).toBe(
			"sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock; base-uri 'none'; object-src 'none'; form-action 'none'",
		)
		expect(page.headers.get("referrer-policy")).toBe("no-referrer")
		expect(page.headers.get("x-content-type-options")).toBe("nosniff")
		const etag = page.headers.get("etag") ?? ""
		expect(etag).toMatch(/^"[0-9a-f]{64}-[0-9a-f]{16}"$/)
		const unchanged = await fetch(url, { headers: { "if-none-match": etag } })
		expect(unchanged.status).toBe(304)
		expect(unchanged.headers.get("etag")).toBe(etag)

		const head = await fetch(url, { method: "HEAD" })
		expect(head.status).toBe(200)
		expect(head.headers.get("content-type")).toBe(page.headers.get("content-type"))
		expect(head.headers.get("content-length")).toBe(String('<script src="app.js"></script>'.length))
		expect(await head.text()).toBe("")

		const script = await fetch(new URL("app.js", url))
		expect(script.status).toBe(200)
		expect(await script.text()).toBe("document.title = 'ok'")

		const forged = new URL(url)
		forged.pathname = forged.pathname.replace(/\.(.)/, (_, first: string) =>
			first === "A" ? ".B" : ".A",
		)
		expect((await fetch(forged)).status).toBe(404)
		expect((await fetch(new URL("/v1/artifacts", url))).status).toBe(404)
		expect((await fetch(`${baseUrl}${url.pathname}`)).status).toBe(404)

		expect((await apiFetch(`/v1/artifacts/${id}`, { method: "DELETE" })).status).toBe(200)
		expect((await fetch(url)).status).toBe(404)
	}, 30_000)

	it("publishes an artifact at a public address that follows the latest version or a pinned one", async () => {
		interface Published {
			readonly publication: { readonly url: string; readonly version: number | null } | null
		}
		const created = await apiJson<{ readonly id: string }>("/v1/artifacts", {
			method: "POST",
			body: { name: "Published", files: [{ path: "index.html", content: "first" }] },
		})
		expect(created.status).toBe(201)
		const id = created.body.id
		const published = await apiJson<Published>(`/v1/artifacts/${id}/publication`, {
			method: "POST",
			body: { version: "latest" },
		})
		expect(published.status).toBe(200)
		const publication = published.body.publication
		expect(publication?.version).toBe(null)
		const url = new URL(publication?.url ?? "")
		expect(url.origin).not.toBe(new URL(baseUrl).origin)
		expect(url.pathname).toMatch(/^\/p\/a[0-9a-f]{1,32}-[0-9a-z]{25}\/$/)

		const page = await fetch(url)
		expect(page.status).toBe(200)
		expect(await page.text()).toBe("first")
		expect(page.headers.get("content-security-policy") ?? "").toContain("sandbox")
		expect(page.headers.get("content-security-policy") ?? "").not.toContain("allow-same-origin")

		const added = await apiFetch(`/v1/artifacts/${id}/versions`, {
			method: "POST",
			body: { version: 1, files: [{ path: "index.html", content: "second" }] },
		})
		expect(added.status).toBe(201)
		expect(await (await fetch(url)).text()).toBe("second")

		const pinned = await apiJson<Published>(`/v1/artifacts/${id}/publication`, {
			method: "POST",
			body: { version: 1 },
		})
		expect(pinned.body.publication).toMatchObject({ url: url.href, version: 1 })
		expect(await (await fetch(url)).text()).toBe("first")

		const unpublished = await apiJson<Published>(`/v1/artifacts/${id}/publication`, {
			method: "DELETE",
		})
		expect(unpublished.status).toBe(200)
		expect(unpublished.body.publication).toBe(null)
		expect((await fetch(url)).status).toBe(404)
		expect((await apiFetch(`/v1/artifacts/${id}`)).status).toBe(200)
	}, 30_000)

	it("lets a page read and write its artifact's data through its own address, as far as the address allows", async () => {
		const created = await apiJson<{ readonly id: string }>("/v1/artifacts", {
			method: "POST",
			body: {
				name: "Poll",
				files: [
					{ path: "index.html", content: "<h1>Poll</h1>" },
					{
						path: "artifact.json",
						content: JSON.stringify({
							capabilities: {
								database: {
									collections: { votes: { visitors: "add" }, tally: { visitors: "read" } },
								},
							},
						}),
					},
				],
			},
		})
		expect(created.status, JSON.stringify(created.body)).toBe(201)
		const id = created.body.id
		const seeded = await apiJson(`/v1/artifacts/${id}/data/tally/current`, {
			method: "PUT",
			body: { data: { yes: 3 } },
		})
		expect(seeded.status).toBe(200)

		const linkFor = async (access: string) => {
			const link = await apiJson<{ readonly url: string; readonly access: string }>(
				`/v1/artifacts/${id}/versions/1/links`,
				{ method: "POST", body: { access } },
			)
			expect(link.body.access).toBe(access)
			return link.body.url
		}
		const viewer = await linkFor("view")
		expect((await sendData(viewer, "tally")).status).toBe(403)
		expect((await fetch(viewer)).status).toBe(200)
		const helper = await fetch(new URL("_/data.js", viewer))
		expect(helper.status).toBe(200)
		expect(helper.headers.get("content-type")).toBe("text/javascript; charset=utf-8")
		expect(await helper.text()).toContain("globalThis.artifactData")

		const reader = await linkFor("read")
		const tally = await sendData(reader, "tally")
		expect(tally.status).toBe(200)
		expect(tally.headers.get("content-type")).toBe("application/json")
		expect(tally.headers.get("cache-control")).toBe("private, no-store")
		expect(tally.headers.get("access-control-allow-origin")).toBe("*")
		expect(
			((await tally.json()) as { data: ReadonlyArray<{ data: unknown }> }).data.map(
				(document) => document.data,
			),
		).toEqual([{ yes: 3 }])
		expect((await sendData(reader, "tally/current")).status).toBe(200)
		expect((await sendData(reader, "votes", "POST", "yes")).status).toBe(403)
		expect((await sendData(reader, "tally/current", "PUT", { yes: 99 })).status).toBe(403)

		const writer = await linkFor("write")
		const preflight = await sendData(writer, "votes", "OPTIONS")
		expect(preflight.status).toBe(204)
		expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, POST, OPTIONS")
		const submit = () => sendData(writer, "votes", "POST", "yes", "test-submission")
		const vote = await submit()
		expect(vote.status).toBe(201)
		const receipt = (await vote.json()) as { id: string }
		expect(typeof receipt.id).toBe("string")
		expect(receipt).toEqual({ id: receipt.id, type: "artifact_document_added" })
		const edit = await apiJson(`/v1/artifacts/${id}/data/votes/${receipt.id}`, {
			method: "PUT",
			body: { data: "reviewed" },
		})
		expect(edit.status).toBe(200)
		expect(await (await submit()).json()).toEqual(receipt)
		expect((await sendData(writer, "votes")).status).toBe(403)
		expect((await sendData(writer, "tally/current", "PUT", { yes: 99 })).status).toBe(403)
		expect((await sendData(writer, "unknown", "POST", 1)).status).toBe(403)
		const held = await apiJson<{ readonly data: ReadonlyArray<{ readonly data: unknown }> }>(
			`/v1/artifacts/${id}/data/votes`,
		)
		expect(held.body.data.map((document) => document.data)).toEqual(["reviewed"])

		const published = await apiJson<{
			readonly publication: { readonly url: string; readonly grants: unknown } | null
		}>(`/v1/artifacts/${id}/publication`, { method: "POST", body: { access: "write" } })
		expect(published.body.publication?.grants).toEqual({ tally: "read", votes: "add" })
		const address = published.body.publication?.url ?? ""
		const publicVote = await sendData(address, "votes", "POST", "no")
		expect(publicVote.status).toBe(201)
		const publicReceipt = (await publicVote.json()) as { readonly id: string }
		expect(typeof publicReceipt.id).toBe("string")
		expect(publicReceipt).toEqual({ id: publicReceipt.id, type: "artifact_document_added" })
		const publicReplay = await sendData(address, "votes", "POST", "yes", "test-submission")
		expect(publicReplay.status).toBe(201)
		expect(await publicReplay.json()).toEqual(receipt)
		expect((await sendData(address, "tally/current")).status).toBe(200)
		expect((await sendData(address, "votes")).status).toBe(403)
		const narrowed = await apiFetch(`/v1/artifacts/${id}/publication`, {
			method: "POST",
			body: { access: "view" },
		})
		expect(narrowed.status).toBe(200)
		expect((await sendData(address, "votes", "POST", "late")).status).toBe(403)

		expect((await apiFetch(`/v1/artifacts/${id}`, { method: "DELETE" })).status).toBe(200)
		expect((await sendData(writer, "votes", "POST", "gone")).status).toBe(404)
		expect((await sendData(address, "tally/current")).status).toBe(404)
	}, 60_000)

	it("answers 429 once a page sends more data calls in a minute than one caller may", async () => {
		const created = await apiJson<{ readonly id: string }>("/v1/artifacts", {
			method: "POST",
			body: {
				name: "Busy",
				files: [
					{ path: "index.html", content: "<h1>Busy</h1>" },
					{
						path: "artifact.json",
						content: JSON.stringify({
							capabilities: { database: { collections: { board: { visitors: "read" } } } },
						}),
					},
				],
			},
		})
		const id = created.body.id
		const link = await apiJson<{ readonly url: string }>(`/v1/artifacts/${id}/versions/1/links`, {
			method: "POST",
			body: { access: "read" },
		})
		const statuses: Array<number> = []
		let slowed: Response | undefined
		for (let batch = 0; batch < 10; batch += 1) {
			const responses = await Promise.all(
				Array.from({ length: 25 }, () => sendData(link.body.url, "board")),
			)
			for (const response of responses) {
				statuses.push(response.status)
				if (response.status === 429) {
					slowed = response
				}
			}
		}
		expect(statuses.filter((status) => status !== 200 && status !== 429)).toEqual([])
		expect(statuses.filter((status) => status === 200).length).toBe(120)
		expect(statuses).toContain(429)
		expect(slowed?.headers.get("retry-after")).toBe("60")
		expect((await fetch(link.body.url)).status).toBe(200)
		expect((await apiFetch(`/v1/artifacts/${id}/data/board`)).status).toBe(200)
		expect((await apiFetch(`/v1/artifacts/${id}`, { method: "DELETE" })).status).toBe(200)
	}, 60_000)

	it("manages webhooks, rotates signing secrets, records deliveries in Durable Object SQLite, and fans out lifecycle events", async () => {
		interface WebhookBody {
			readonly id: string
			readonly status: string
			readonly secret_revision: number
			readonly previous_secret_expires_at: string | null
			readonly signing_secret?: string
		}
		interface DeliveryBody {
			readonly id: string
			readonly event_type: string
			readonly status: string
			readonly last_outcome: string | null
		}

		const badUrl = await apiFetch("/v1/webhooks", {
			method: "POST",
			body: { url: "http://127.0.0.1/hook", event_types: ["*"] },
		})
		expect(badUrl.status).toBe(400)

		const created = await apiJson<WebhookBody>("/v1/webhooks", {
			method: "POST",
			body: {
				url: "https://127.0.0.1.nip.io/workerd-webhook",
				description: "Workerd webhook test",
				event_types: ["agent.created"],
			},
		})
		expect(created.status).toBe(201)
		expect(created.body.status).toBe("active")
		expect(created.body.secret_revision).toBe(1)
		expect(created.body.signing_secret?.startsWith("whsec_")).toBe(true)
		const webhookId = created.body.id

		// Registration is immediately visible in D1 WebhookListing upon 201 (no polling required).
		const page = await apiJson<{ readonly data: ReadonlyArray<{ readonly id: string }> }>(
			"/v1/webhooks?limit=100",
		)
		expect(page.status).toBe(200)
		expect(page.body.data.map((item) => item.id)).toContain(webhookId)

		const rotated = await apiJson<WebhookBody>(`/v1/webhooks/${webhookId}/rotate-secret`, {
			method: "POST",
		})
		expect(rotated.status).toBe(200)
		expect(rotated.body.secret_revision).toBe(2)
		expect(rotated.body.previous_secret_expires_at).not.toBeNull()
		expect(rotated.body.signing_secret?.startsWith("whsec_")).toBe(true)
		expect(rotated.body.signing_secret).not.toBe(created.body.signing_secret)

		const testDelivery = await apiJson<DeliveryBody>(`/v1/webhooks/${webhookId}/test`, {
			method: "POST",
		})
		expect(testDelivery.status).toBe(201)
		expect(testDelivery.body.event_type).toBe("webhook.test")

		// In local Alchemy workerd without CHECKFU_WEBHOOK_EGRESS_URL, direct delivery fails
		// closed as a sender configuration error without degrading endpoint health.
		const localEgressDeadline = Date.now() + 15_000
		let fetchedDelivery = await apiJson<DeliveryBody>(
			`/v1/webhooks/${webhookId}/deliveries/${testDelivery.body.id}`,
		)
		while (fetchedDelivery.body.status === "pending" && Date.now() < localEgressDeadline) {
			await sleep(150)
			fetchedDelivery = await apiJson<DeliveryBody>(
				`/v1/webhooks/${webhookId}/deliveries/${testDelivery.body.id}`,
			)
		}
		expect(fetchedDelivery.status).toBe(200)
		expect(fetchedDelivery.body.id).toBe(testDelivery.body.id)
		expect(fetchedDelivery.body.status).toBe("failed")
		expect(fetchedDelivery.body.last_outcome).toBe("network_error")

		const afterLocalRefusal = await apiJson<
			WebhookBody & {
				readonly consecutive_failures: number
				readonly last_failure_at: string | null
			}
		>(`/v1/webhooks/${webhookId}`)
		expect(afterLocalRefusal.status).toBe(200)
		expect(afterLocalRefusal.body.status).toBe("active")
		expect(afterLocalRefusal.body.consecutive_failures).toBe(0)
		expect(afterLocalRefusal.body.last_failure_at).toBeNull()

		// Creating an agent triggers PublishWebhookEvents -> WebhookEventsLive -> WebhookDeliverer DO SQLite.
		const triggeredAgent = await apiJson<{ readonly id: string }>("/v1/agents", {
			method: "POST",
			body: { name: "Webhook Fanout Agent", model: "gpt-4o-mini" },
		})
		expect(triggeredAgent.status).toBe(201)

		const deliveryDeadline = Date.now() + 15_000
		let eventTypes: ReadonlyArray<string> = []
		while (!eventTypes.includes("agent.created") && Date.now() < deliveryDeadline) {
			const deliveriesPage = await apiJson<{ readonly data: ReadonlyArray<DeliveryBody> }>(
				`/v1/webhooks/${webhookId}/deliveries?limit=50`,
			)
			expect(deliveriesPage.status).toBe(200)
			eventTypes = deliveriesPage.body.data.map((item) => item.event_type)
			if (!eventTypes.includes("agent.created")) {
				await sleep(150)
			}
		}
		expect(eventTypes).toContain("webhook.test")
		expect(eventTypes).toContain("agent.created")

		const paused = await apiJson<WebhookBody>(`/v1/webhooks/${webhookId}/pause`, {
			method: "POST",
		})
		expect(paused.status).toBe(200)
		expect(paused.body.status).toBe("paused")

		const resumed = await apiJson<WebhookBody>(`/v1/webhooks/${webhookId}/resume`, {
			method: "POST",
		})
		expect(resumed.status).toBe(200)
		expect(resumed.body.status).toBe("active")

		const deleted = await apiFetch(`/v1/webhooks/${webhookId}`, { method: "DELETE" })
		expect(deleted.status).toBe(200)
		expect((await apiFetch(`/v1/webhooks/${webhookId}`)).status).toBe(404)
	}, 30_000)

	it("calls MCP servers from scripts and, once found, directly, keeping the credential in its connection", async () => {
		const token = "tok/mcp+SECRET&workerd=1"
		const secure = await startFakeMcpServer([token], { stateful: true })
		const open = await startFakeMcpServer(null, { modern: true })
		try {
			const agent = await createResource<{ readonly id: string }>("/v1/agents", {
				name: "MCP Agent",
				model: "gpt-4o-mini",
				mcp_servers: [
					{ type: "url", name: "secure", url: secure.url },
					{ type: "url", name: "open", url: open.url },
				],
				tools: ["secure", "open"].map((mcp_server_name) => ({
					type: "mcp_toolset",
					mcp_server_name,
					default_config: { permission_policy: { type: "always_allow" } },
				})),
			})
			const vaults = await Promise.all(
				[0, 1].map(() =>
					createResource<{ readonly id: string }>("/v1/vaults", { display_name: "mcp" }),
				),
			)
			const credentials = await Promise.all(
				vaults.map((vault) =>
					createResource<{ readonly id: string }>(`/v1/vaults/${vault.id}/credentials`, {
						auth: { type: "static_bearer", token, mcp_server_url: secure.url },
					}),
				),
			)
			const vault_ids = vaults.map((vault) => vault.id)
			const ambiguous = await apiFetch("/v1/sessions", {
				method: "POST",
				body: { agent: agent.id, environment_id: environmentId, vault_ids },
			})
			expect(ambiguous.status).toBe(400)
			expect(await ambiguous.text()).toContain(String.raw`\"secure\"`)

			const script =
				'const leaked = await tools.mcp__secure__leak({}); const echoed = await tools.mcp__open__echo({ text: "from-script" }); return [JSON.stringify(leaked), echoed].join(" ");'
			fakeOpenAI.setHandler((req) => {
				switch (req.toolOutputs.length) {
					case 0:
						return { kind: "tool_call", name: "mcp__open__echo", arguments: { text: "too-early" } }
					case 1:
						return { kind: "tool_call", name: "codemode", arguments: { code: script } }
					case 2:
						return { kind: "tool_call", name: "tool_search", arguments: { query: "echo" } }
					case 3:
						return { kind: "tool_call", name: "mcp__open__echo", arguments: { text: "direct" } }
					default:
						return { kind: "reply", text: "Done." }
				}
			})
			const run = async () => {
				const session = await createResource<SessionResource & { mcp_server_credentials: unknown }>(
					"/v1/sessions",
					{
						agent: agent.id,
						environment_id: environmentId,
						vault_ids,
						mcp_server_credentials: [
							{ mcp_server_name: "secure", credential_id: credentials[1]?.id },
						],
					},
				)
				expect(session.mcp_server_credentials).toEqual([
					{
						mcp_server_name: "secure",
						credential_id: credentials[1]?.id,
						vault_id: vaults[1]?.id,
					},
				])
				const sent = await apiJson(`/v1/sessions/${session.id}/events`, {
					method: "POST",
					body: {
						events: [{ type: "user.message", content: [{ type: "text", text: "Use the tools." }] }],
					},
				})
				expect(sent.status).toBe(200)
				await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 1, 60_000)
				return { session, events: await listAllEvents(session.id) }
			}

			const first = await run()
			const second = await run()

			expect(secure.calls.map((call) => [call.tool, call.token])).toEqual([
				["leak", token],
				["leak", token],
			])
			const upstreamSessions = secure.calls.map((call) => call.session)
			expect(new Set(upstreamSessions).size).toBe(2)
			expect(open.calls.map((call) => [call.arguments, call.token])).toEqual([
				[{ text: "from-script" }, undefined],
				[{ text: "direct" }, undefined],
				[{ text: "from-script" }, undefined],
				[{ text: "direct" }, undefined],
			])

			const { events } = first
			const mcpUses = events.filter((e) => e.type === "agent.mcp_tool_use")
			expect(mcpUses.map((e) => [e.mcp_server_name, e.name])).toEqual([
				["open", "echo"],
				["open", "echo"],
			])
			expect(mcpUses.map((e) => e.input)).toEqual([{ text: "too-early" }, { text: "direct" }])
			for (const use of mcpUses) {
				expect(toolUseOf(toolUseIdFromEvent(first.session.id, use.tool_use_id ?? ""))).toBeDefined()
			}
			const mcpResults = events.filter((e) => e.type === "agent.mcp_tool_result")
			expect(
				mcpResults.map((e) => e.tool_use_id).toSorted((a, b) => (a ?? "").localeCompare(b ?? "")),
			).toEqual(
				mcpUses.map((e) => e.tool_use_id).toSorted((a, b) => (a ?? "").localeCompare(b ?? "")),
			)
			expect(mcpResults.find((e) => e.tool_use_id === mcpUses[0]?.tool_use_id)?.is_error).toBe(true)
			expect(mcpResults.find((e) => e.tool_use_id === mcpUses[1]?.tool_use_id)?.is_error).toBe(
				false,
			)

			const visible = JSON.stringify([first, second, workerLogs])
			for (const form of [
				token,
				encodeURIComponent(token),
				new URLSearchParams({ s: token }).toString().slice(2),
				JSON.stringify(token).slice(1, -1),
			]) {
				expect(visible).not.toContain(form)
			}
			expect(visible).toContain("[redacted]")
		} finally {
			await secure.close()
			await open.close()
		}
	}, 120_000)

	it("sends a session's server nothing with a credential once its archive, its delete or its vault's archive has answered", async () => {
		const token = "tok-revoked-workerd-secret-1"
		const secure = await startFakeMcpServer([token])
		try {
			const agent = await createResource<{ readonly id: string }>("/v1/agents", {
				name: "Revoked MCP Agent",
				model: "gpt-4o-mini",
				mcp_servers: [{ type: "url", name: "secure", url: secure.url }],
				tools: [
					{
						type: "mcp_toolset",
						mcp_server_name: "secure",
						default_config: { permission_policy: { type: "always_allow" } },
					},
				],
			})
			const script =
				'try { return await tools.mcp__secure__echo({ text: "hi" }) } catch (e) { return String(e) }'
			const revocations: ReadonlyArray<
				(vaultId: string, credentialId: string) => readonly [string, string]
			> = [
				(vaultId, credentialId) => [
					"POST",
					`/v1/vaults/${vaultId}/credentials/${credentialId}/archive`,
				],
				(vaultId, credentialId) => ["DELETE", `/v1/vaults/${vaultId}/credentials/${credentialId}`],
				(vaultId) => ["POST", `/v1/vaults/${vaultId}/archive`],
			]
			for (const revoke of revocations) {
				const vault = await createResource<{ readonly id: string }>("/v1/vaults", {
					display_name: "revoked",
				})
				const credential = await createResource<{ readonly id: string }>(
					`/v1/vaults/${vault.id}/credentials`,
					{ auth: { type: "static_bearer", token, mcp_server_url: secure.url } },
				)
				const session = await createResource<SessionResource>("/v1/sessions", {
					agent: agent.id,
					environment_id: environmentId,
					vault_ids: [vault.id],
				})
				const turn = async (number: number) => {
					fakeOpenAI.setHandler(runsScript(script))
					const sent = await apiJson(`/v1/sessions/${session.id}/events`, {
						method: "POST",
						body: {
							events: [{ type: "user.message", content: [{ type: "text", text: "Call it." }] }],
						},
					})
					expect(sent.status).toBe(200)
					await waitForSession(session.id, (s) => s.status === "idle" && s.turn === number, 60_000)
					const events = await listAllEvents(session.id)
					const use = events.filter((e) => e.type === "agent.tool_use" && e.name === "codemode")[
						number - 1
					]
					return (
						events
							.find((e) => e.type === "agent.tool_result" && e.tool_use_id === use?.tool_use_id)
							?.content?.map((block) => block.text)
							.join("") ?? ""
					)
				}

				expect(await turn(1)).toContain("echo:hi")
				const authenticated = secure.tokens.filter((sent) => sent === token).length
				expect(authenticated).toBeGreaterThan(0)

				const [method, path] = revoke(vault.id, credential.id)
				expect((await apiJson(path, { method })).status).toBe(200)
				const after = await turn(2)
				expect(after).toContain("archived or deleted")
				expect(after).not.toContain("echo:hi")
				expect(secure.tokens.filter((sent) => sent === token).length).toBe(authenticated)
			}
		} finally {
			await secure.close()
		}
	}, 240_000)

	it("refuses at the session object what changed since admission, keeps one server's trouble to itself, and sends nothing once interrupted", async () => {
		const raw = await startScriptedMcpServer()
		const huge = await startScriptedMcpServer({ pages: 40, pageBytes: 64 * 1024 })
		try {
			const hosts = [raw, huge].map((server) => new URL(server.url).host)
			const environment = await createResource<{ readonly id: string }>("/v1/environments", {
				name: "MCP rules",
				config: limitedTo(hosts),
			})
			const agent = await createResource<{ readonly id: string }>("/v1/agents", {
				name: "Scripted MCP Agent",
				model: "gpt-4o-mini",
				mcp_servers: [
					{ type: "url", name: "raw", url: raw.url },
					{ type: "url", name: "huge", url: huge.url },
				],
				tools: ["raw", "huge"].map((mcp_server_name) => ({
					type: "mcp_toolset",
					mcp_server_name,
					default_config: { permission_policy: { type: "always_allow" } },
				})),
			})
			const session = await createResource<SessionResource>("/v1/sessions", {
				agent: agent.id,
				environment_id: environment.id,
			})
			const say = async (text: string) => {
				const sent = await apiJson(`/v1/sessions/${session.id}/events`, {
					method: "POST",
					body: { events: [{ type: "user.message", content: [{ type: "text", text }] }] },
				})
				expect(sent.status).toBe(200)
			}
			const rules = async (version: number, allowed: ReadonlyArray<string>) => {
				const updated = await apiJson(`/v1/environments/${environment.id}`, {
					method: "POST",
					body: { version, config: limitedTo(allowed) },
				})
				expect(updated.status).toBe(200)
			}
			const scriptResult = async (nth: number) => {
				const events = await listAllEvents(session.id)
				const use = events.filter((e) => e.type === "agent.tool_use" && e.name === "codemode")[nth]
				const result = events.find(
					(e) => e.type === "agent.tool_result" && e.tool_use_id === use?.tool_use_id,
				)
				return result?.content?.map((block) => block.text).join("") ?? ""
			}

			const together = [
				"const settled = await Promise.allSettled([",
				"  tools.mcp__raw__boom({}),",
				'  tools.mcp__raw__echo({ text: "beside", delay_ms: 100 }),',
				"]);",
				"return JSON.stringify(settled.map((one) => one.status === 'fulfilled' ? one.value : String(one.reason)));",
			].join("\n")
			fakeOpenAI.setHandler(runsScript(together))
			await say("Call both.")
			await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 1, 60_000)
			const both = await scriptResult(0)
			expect(both).toContain("boom failed")
			expect(both).toContain("echo:beside:scripted-1")
			expect(raw.methods.filter((method) => method === "initialize")).toHaveLength(1)
			const pages = huge.methods.filter((method) => method === "tools/list").length
			expect(pages).toBeGreaterThan(1)
			expect(pages).toBeLessThanOrEqual(5)
			expect(huge.methods).not.toContain("tools/call")

			await rules(1, [])
			const before = raw.methods.length
			fakeOpenAI.setHandler(
				runsScript(
					'try { return await tools.mcp__raw__echo({ text: "after" }) } catch (e) { return String(e) }',
				),
			)
			await say("Call again.")
			await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 2, 60_000)
			expect(await scriptResult(1)).toContain("network rules do not allow")
			expect(raw.methods.length).toBe(before)

			await rules(2, hosts)
			raw.expireSessions()
			const release = raw.holdHandshakes()
			fakeOpenAI.setHandler((req) => {
				switch (req.toolOutputs.length) {
					case 0:
						return { kind: "tool_call", name: "tool_search", arguments: { query: "echo" } }
					case 1:
						return { kind: "tool_call", name: "mcp__raw__echo", arguments: { text: "expired" } }
					case 2:
						return { kind: "tool_call", name: "mcp__raw__echo", arguments: { text: "never" } }
					default:
						return { kind: "reply", text: "Done." }
				}
			})
			await say("Call once more.")
			const deadline = Date.now() + 30_000
			while (!raw.methods.slice(before).includes("initialize")) {
				expect(Date.now(), raw.methods.slice(before).join()).toBeLessThan(deadline)
				await sleep(20)
			}
			const interrupted = await apiJson(`/v1/sessions/${session.id}/events`, {
				method: "POST",
				body: { events: [{ type: "user.interrupt" }] },
			})
			expect(interrupted.status).toBe(200)
			await waitForSession(session.id, (s) => s.status === "idle" && s.turn === 3, 60_000)
			release()
			await sleep(500)
			expect(raw.methods.slice(before)).toEqual(["tools/call", "server/discover", "initialize"])
		} finally {
			await raw.close()
			await huge.close()
		}
	}, 180_000)

	it("pauses a turn on a call that asks and on a custom tool, and goes on once each is answered", async () => {
		const open = await startFakeMcpServer(null, { modern: true })
		try {
			const agent = await createResource<{ readonly id: string }>("/v1/agents", {
				name: "Asking Agent",
				model: "gpt-4o-mini",
				mcp_servers: [{ type: "url", name: "open", url: open.url }],
				tools: [
					{
						type: "custom",
						name: "lookup_order",
						description: "Looks an order up",
						input_schema: {
							type: "object",
							properties: { order: { type: "integer" } },
							required: ["order"],
						},
					},
				],
			})
			fakeOpenAI.setHandler((req) => {
				switch (req.toolOutputs.length) {
					case 0:
						return { kind: "tool_call", name: "tool_search", arguments: { query: "echo" } }
					case 1:
						return { kind: "tool_call", name: "mcp__open__echo", arguments: { text: "approved" } }
					case 2:
						return { kind: "tool_call", name: "lookup_order", arguments: { order: "42" } }
					default:
						return { kind: "reply", text: "Done." }
				}
			})
			const session = await createResource<SessionResource>("/v1/sessions", {
				agent: agent.id,
				environment_id: environmentId,
			})
			const send = (event: unknown) =>
				apiJson(`/v1/sessions/${session.id}/events`, { method: "POST", body: { events: [event] } })
			expect(
				(await send({ type: "user.message", content: [{ type: "text", text: "Go." }] })).status,
			).toBe(200)
			const waitingOn = async (count: number) => {
				for (let attempt = 0; attempt < 600; attempt++) {
					const events = await listAllEvents(session.id)
					const pauses = events.filter(
						(e) => e.type === "session.status_idle" && e.stop_reason?.type === "requires_action",
					)
					if (pauses.length >= count) {
						return { events, ids: pauses.at(-1)?.stop_reason?.event_ids ?? [] }
					}
					await sleep(100)
				}
				throw new Error(`the turn did not pause ${count} times`)
			}
			const first = await waitingOn(1)
			const asked = first.events.find((e) => e.type === "agent.mcp_tool_use")
			expect(asked).toMatchObject({
				name: "echo",
				evaluated_permission: "ask",
				input: { text: "approved" },
			})
			expect(first.ids).toEqual([asked?.tool_use_id])
			expect(open.calls).toEqual([])
			expect(
				(
					await send({
						type: "user.tool_confirmation",
						tool_use_id: asked?.tool_use_id,
						result: "allow",
					})
				).status,
			).toBe(200)
			const second = await waitingOn(2)
			const custom = second.events.find((e) => e.type === "agent.custom_tool_use")
			expect(custom).toMatchObject({ name: "lookup_order", input: { order: 42 } })
			expect(open.calls.map((call) => call.arguments)).toEqual([{ text: "approved" }])
			expect(
				(
					await send({
						type: "user.custom_tool_result",
						custom_tool_use_id: custom?.tool_use_id,
						content: [{ type: "text", text: "shipped" }],
					})
				).status,
			).toBe(200)
			let events = await listAllEvents(session.id)
			for (
				let attempt = 0;
				attempt < 600 && !events.some((e) => e.type === "agent.message");
				attempt++
			) {
				await sleep(100)
				events = await listAllEvents(session.id)
			}
			const last = events.filter((e) => e.type === "session.status_idle").at(-1)
			expect(last?.stop_reason?.type).toBe("end_turn")
			expect(events.find((e) => e.type === "agent.message")?.content?.[0]?.text).toBe("Done.")
			expect(events.filter((e) => e.type === "agent.mcp_tool_use")).toHaveLength(1)
		} finally {
			await open.close()
		}
	}, 120_000)
})
