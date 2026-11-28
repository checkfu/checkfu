import assert from "node:assert/strict"
import Checkfu, { CheckfuClient, NotFoundError } from "@checkfu/sdk"
import * as Effect from "effect/Effect"

const [baseUrl, apiKey, cliAgentId, cliSessionId] = process.argv.slice(2)
const client = new Checkfu({ baseUrl, apiKey, maxRetries: 0 })
const retryClient = new Checkfu({ baseUrl, apiKey, maxRetries: 0 })
try {
	assert.equal((await client.agents.retrieve(cliAgentId)).name, "Installed CLI")
	const piped = await client.sessions.retrieve(cliSessionId)
	assert.equal(piped.status, "terminated")
	assert.equal(piped.turn, 2)
	const pipedEvents = []
	for await (const event of client.sessions.events.list(cliSessionId, { limit: 2 })) {
		pipedEvents.push(event)
	}
	assert.deepEqual(
		pipedEvents.flatMap((event) => (event.type === "user.message" ? [event.content[0].text] : [])),
		["First piped message", "Last message without newline"],
	)
	const replies = pipedEvents.filter((event) => event.type === "agent.message")
	assert.equal(replies.length, 2)
	assert(replies.at(-1).content[0].text.includes("Last message without newline"))
	assert.equal(new Set(pipedEvents.map((event) => event.id)).size, pipedEvents.length)
	const body = { name: "Installed SDK", model: "gpt-4o-mini", system: "Original instructions" }
	const options = { idempotencyKey: "npm-sdk-create-retry" }
	const first = await client.waitForPending(await client.agents.create(body, options))
	const retry = await retryClient.waitForPending(await retryClient.agents.create(body, options))
	assert.equal(retry.id, first.id)
	await assert.rejects(retryClient.agents.create({ ...body, name: "Conflicting retry" }, options), {
		status: 409,
	})
	const updated = await client.waitForPending(
		await client.agents.update(first.id, {
			description: "New description",
			version: first.version,
		}),
	)
	assert.equal(updated.version, 2)
	await assert.rejects(
		client.agents.update(first.id, {
			version: first.version,
			description: "Stale SDK edit must never be saved",
		}),
		{ status: 409 },
	)
	const independentlyRead = await fetch(`${baseUrl}/v1/agents/${first.id}`, {
		headers: { authorization: `Bearer ${apiKey}` },
	})
	assert.equal(independentlyRead.status, 200)
	const saved = await independentlyRead.json()
	assert.equal(saved.version, 2)
	assert.equal(saved.description, "New description")
	assert.equal((await client.agents.retrieve(first.id, { version: 1 })).description, null)
	const history = []
	for await (const version of client.agents.versions.list(first.id, { limit: 1 })) {
		history.push(version.version)
	}
	assert.deepEqual(history, [2, 1])
	await assert.rejects(
		client.agents.retrieve("agent_missing"),
		(error) =>
			error instanceof NotFoundError && error.status === 404 && error._tag === "NotFoundError",
	)
	const effectId = await Effect.runPromise(
		Effect.gen(function* () {
			const effectClient = yield* CheckfuClient
			return (yield* effectClient.agents.retrieve(first.id)).id
		}).pipe(Effect.provide(CheckfuClient.layerFetch({ apiKey, baseUrl }))),
	)
	assert.equal(effectId, first.id)
	const binary = new Uint8Array([0, 127, 255, 128])
	const uploaded = await client.files.upload({
		filename: "fixture.bin",
		content_type: "application/octet-stream",
		body: binary,
	})
	const downloaded = await Effect.runPromise(
		Effect.gen(function* () {
			const effectClient = yield* CheckfuClient
			return yield* effectClient.files.content(uploaded.id, { withResponse: true })
		}).pipe(Effect.provide(CheckfuClient.layerFetch({ apiKey, baseUrl }))),
	)
	assert.equal(downloaded.status, 200)
	assert.equal(downloaded.headers["content-type"], "application/octet-stream")
	assert.deepEqual(downloaded.data, binary)
	const pinnedFile = "assets/résumé #1.bin"
	const originalBytes = Uint8Array.of(0, 127, 255)
	const original = await client.artifacts.create({
		name: "Pinned binary asset",
		files: [
			{
				path: pinnedFile,
				content: Buffer.from(originalBytes).toString("base64"),
				encoding: "base64",
			},
		],
	})
	const newer = await client.artifacts.versions.create(original.id, {
		version: original.version,
		files: [{ path: pinnedFile, content: "new content" }],
	})
	assert.equal(newer.version, 2)
	const pinned = await client.artifacts.versions.content(original.id, 1, { file: pinnedFile })
	assert.deepEqual(pinned, originalBytes)
	const pinnedEffect = await Effect.runPromise(
		Effect.gen(function* () {
			const sdk = yield* CheckfuClient
			return yield* sdk.artifacts.versions.content(
				original.id,
				1,
				{ file: pinnedFile },
				{ withResponse: true },
			)
		}).pipe(Effect.provide(CheckfuClient.layerFetch({ apiKey, baseUrl }))),
	)
	assert.equal(pinnedEffect.status, 200)
	assert.deepEqual(pinnedEffect.data, originalBytes)
	const environment = await client.waitForPending(
		await client.environments.create({ name: "Installed SDK environment" }),
	)
	const session = await client.waitForPending(
		await client.sessions.create({ agent: first.id, environment_id: environment.id }),
	)
	await client.sessions.events.send(session.id, {
		events: [
			{ type: "user.message", content: [{ type: "text", text: "Hello from installed SDK" }] },
		],
	})
	let events = []
	for (let i = 0; i < 100; i++) {
		events = []
		for await (const event of client.sessions.events.list(session.id, { limit: 2 })) {
			events.push(event)
		}
		if (events.some((event) => event.type === "agent.message")) {
			break
		}
		await new Promise((resolve) => {
			setTimeout(resolve, 20)
		})
	}
	assert.equal(events.filter((event) => event.type === "agent.message").length, 1)
	assert.equal(new Set(events.map((event) => event.id)).size, events.length)
	assert.equal(
		events.find((event) => event.type === "agent.message").content[0].text,
		"Echo: Hello from installed SDK",
	)
	await client.waitForPending(await client.sessions.archive(session.id))
	const stream = await client.sessions.events.stream(session.id)
	const streamed = []
	for await (const event of stream) {
		streamed.push(event)
	}
	assert.equal(streamed.filter((event) => event.type === "agent.message").length, 1)
	process.stdout.write(
		JSON.stringify({
			agent_id: first.id,
			session_id: session.id,
			versions: history,
			events: events.length,
			streamed: streamed.length,
		}),
	)
} finally {
	await retryClient.close()
	await client.close()
}
