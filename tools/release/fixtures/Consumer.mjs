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
