import { createServer } from "node:http"
import { expect, it } from "vitest"
import { WEBHOOK_FANOUT_PAGE_SIZE } from "../../src/Webhooks/WebhookEventsLive.ts"
import { WEBHOOK_FANOUT_DEDUPE_TTL_MS } from "../../src/Webhooks/WebhookFanout.do.ts"
import { WEBHOOK_EGRESS_TARGET_HEADER } from "../../src/Webhooks/WebhookEgressConfig.ts"
import type { FanoutStatus } from "./WebhookFanoutFixture.ts"
import {
	TEST_CUSTOM_PROVIDER_ID,
	sha256Hex,
	parseResponseJson,
	webhookFanoutFixture,
	startAlchemyDev,
	apiAt,
} from "./WorkerdStack.ts"

it("retries one failed enqueue after the durable fan-out scan completes", async () => {
	const unusedProvider = "http://127.0.0.1:1"
	const worker = await startAlchemyDev(unusedProvider, unusedProvider, undefined, {
		fixture: webhookFanoutFixture,
	})
	const send = async (path: string) => {
		const response = await fetch(`${worker.baseUrl}${path}`, { method: "POST" })
		expect(response.status, await response.text()).toBe(200)
	}
	const status = async () => {
		const response = await fetch(`${worker.baseUrl}/status`)
		const raw = await response.text()
		expect(response.status, raw).toBe(200)
		return parseResponseJson<FanoutStatus>("GET", "/status", response.status, raw)
	}
	try {
		await send("/publish")
		await expect.poll(status, { timeout: 15_000 }).toMatchObject({
			started: true,
			scanDone: true,
			pendingCount: 1,
			retryPending: true,
		})
		const pending = await status()
		expect(pending.jobs.map(({ callback }) => callback)).toContain("retrySubscriber")
		expect(pending.jobs.map(({ callback }) => callback)).not.toContain("cleanup")
		expect(pending.deliveries).toHaveLength(pending.subscriberCount - 1)
		expect(
			pending.deliveries.some(({ webhookId }) => webhookId === pending.retrySubscriberId),
		).toBe(false)
		const releasedAt = Date.now()
		await send("/release")
		await expect.poll(status, { timeout: 15_000 }).toMatchObject({
			started: true,
			scanDone: true,
			pendingCount: null,
			retryPending: null,
			jobs: [{ callback: "cleanup" }],
		})
		const settled = await status()
		expect(settled.jobs[0]?.scheduled_at).toBeGreaterThanOrEqual(
			releasedAt + WEBHOOK_FANOUT_DEDUPE_TTL_MS,
		)
		expect(settled.jobs[0]?.scheduled_at).toBeLessThanOrEqual(
			Date.now() + WEBHOOK_FANOUT_DEDUPE_TTL_MS,
		)
		const retried = settled.attempts.filter(
			({ webhookId }) => webhookId === settled.retrySubscriberId,
		)
		expect(retried).toHaveLength(2)
		expect(retried[1]).toEqual(retried[0])
		expect(
			settled.attempts.filter(({ webhookId }) => webhookId !== settled.retrySubscriberId),
		).toEqual(pending.deliveries)
		expect(settled.deliveries).toEqual([...pending.deliveries, retried[0]])
		await send("/publish")
		const replay = await status()
		expect(replay.attempts).toHaveLength(settled.attempts.length + WEBHOOK_FANOUT_PAGE_SIZE)
		expect(replay.deliveries).toEqual(settled.deliveries)
		expect(replay.jobs.map(({ callback }) => callback)).toEqual(["cleanup"])
		await send("/cleanup")
		await expect.poll(status, { timeout: 10_000 }).toMatchObject({
			started: null,
			scanDone: null,
			pendingCount: null,
			retryPending: null,
			jobs: [],
			deliveries: settled.deliveries,
		})
	} finally {
		await worker.stop()
	}
}, 240_000)

it("fans a single event out across three subscriber pages in Durable Objects", async () => {
	interface Delivery {
		readonly id: string
		readonly webhook_id: string
		readonly event_id: string
		readonly event_type: string
		readonly status: string
	}
	const received: Array<{ readonly target: string; readonly body: string }> = []
	const receiver = createServer((request, response) => {
		const target = request.headers[WEBHOOK_EGRESS_TARGET_HEADER]
		if (request.method !== "POST" || request.url !== "/egress" || typeof target !== "string") {
			response.writeHead(400).end()
			return
		}
		let body = ""
		request.setEncoding("utf8")
		request.on("data", (chunk: string) => {
			body += chunk
		})
		request.on("end", () => {
			received.push({ target, body })
			response.writeHead(200, { "content-type": "application/json" })
			response.end(JSON.stringify({ kind: "response", status: 204 }))
		})
	})
	try {
		await new Promise<void>((resolveListen, rejectListen) => {
			receiver.once("error", rejectListen)
			receiver.listen(0, "127.0.0.1", resolveListen)
		})
		const address = receiver.address()
		if (address === null || typeof address === "string") {
			throw new Error("The local webhook receiver has no port.")
		}
		const unusedProvider = "http://127.0.0.1:1"
		const worker = await startAlchemyDev(unusedProvider, unusedProvider, undefined, {
			webhookEgressUrl: `http://127.0.0.1:${address.port}/egress`,
		})
		try {
			const { apiJson } = apiAt(() => worker.baseUrl)
			const register = async (label: string, eventType: string) => {
				const url = `https://receiver.example.test/${label}`
				const { status, body } = await apiJson<{ readonly id: string }>("/v1/webhooks", {
					method: "POST",
					body: { url, event_types: [eventType] },
				})
				expect(status).toBe(201)
				return { id: body.id, url }
			}
			const deliveriesFor = async (id: string) => {
				const page = await apiJson<{ readonly data: ReadonlyArray<Delivery> }>(
					`/v1/webhooks/${id}/deliveries`,
				)
				expect(page.status).toBe(200)
				return page.body.data
			}
			const nonmatching = await register("nonmatching", "agent.archived")
			const matching: Array<Awaited<ReturnType<typeof register>>> = []
			for (let index = 0; index < WEBHOOK_FANOUT_PAGE_SIZE * 2 + 1; index++) {
				matching.push(await register(`subscriber-${index}`, "agent.created"))
			}
			const send = () =>
				apiJson<{ readonly id: string }>("/v1/agents", {
					method: "POST",
					headers: { "idempotency-key": "three-webhook-subscriber-pages" },
					body: {
						name: "Webhook continuations",
						model: `${TEST_CUSTOM_PROVIDER_ID}/custom-model-v1`,
					},
				})
			const agent = await send()
			expect(agent.status).toBe(201)
			const eventId = `evt_agent_${agent.body.id}_1`
			const late = await register("late", "agent.created")
			const readDeliveries = () => Promise.all(matching.map(({ id }) => deliveriesFor(id)))
			await expect
				.poll(
					async () => {
						const pages = await readDeliveries()
						return pages.flat().filter(({ status }) => status === "succeeded").length
					},
					{ timeout: 15_000 },
				)
				.toBe(matching.length)
			const pages = await readDeliveries()
			expect(
				pages.map((page) =>
					page.map(({ id, webhook_id, event_id, event_type, status }) => [
						id,
						webhook_id,
						event_id,
						event_type,
						status,
					]),
				),
			).toEqual(
				matching.map(({ id }) => [
					[
						`wdel_${sha256Hex(`wdel:${id}:${eventId}`).slice(0, 24)}`,
						id,
						eventId,
						"agent.created",
						"succeeded",
					],
				]),
			)
			const replay = await send()
			expect(replay.status).toBe(201)
			expect(replay.body.id).toBe(agent.body.id)
			expect(await readDeliveries()).toEqual(pages)
			expect(await deliveriesFor(nonmatching.id)).toEqual([])
			expect(await deliveriesFor(late.id)).toEqual([])
			expect(received.map(({ target }) => target).sort()).toEqual(
				matching.map(({ url }) => url).sort(),
			)
			for (const { body } of received) {
				const payload: unknown = JSON.parse(body)
				expect(payload).toMatchObject({
					type: "event",
					id: eventId,
					data: { type: "agent.created", id: agent.body.id },
				})
			}
		} finally {
			await worker.stop()
		}
	} finally {
		receiver.closeAllConnections()
		await new Promise<void>((resolveClose) => {
			receiver.close(() => resolveClose())
		})
	}
}, 240_000)
