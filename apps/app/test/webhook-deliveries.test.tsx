// @vitest-environment happy-dom
import { QueryClientProvider } from "@tanstack/react-query"
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router"
import { act, fireEvent, render } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import type { JsonWebhook, JsonWebhookDelivery } from "../src/api.ts"
import { webhookDeliveryQuery, webhookQuery } from "../src/queries.ts"
import { routeTree } from "../src/routeTree.gen.ts"
import { newQueryClient, stubApi } from "./dom.tsx"

const at = "2026-11-28T12:00:00Z"
const webhook = {
	id: "wh_fixture",
	type: "webhook",
	description: "Workflows",
	status: "paused",
	url: "https://hooks.example.test/private-path?key=private-query",
	event_types: ["*"],
	definition_revision: 2,
	secret_revision: 1,
	previous_secret_expires_at: null,
	consecutive_failures: 1,
	last_failure_at: at,
	created_at: at,
	updated_at: at,
} satisfies JsonWebhook
const delivery = {
	id: "wdel_failed",
	type: "webhook_delivery",
	webhook_id: webhook.id,
	event_id: "evt_shared",
	event_type: "session.status_idled",
	status: "failed",
	attempt_count: 6,
	max_attempts: 6,
	next_attempt_at: null,
	last_attempt_at: at,
	last_http_status: 503,
	last_outcome: "http_5xx",
	last_error: "private-error",
	created_at: at,
	updated_at: at,
	completed_at: at,
} satisfies JsonWebhookDelivery
const later = {
	...delivery,
	id: "wdel_replay",
	status: "pending",
	attempt_count: 0,
	next_attempt_at: at,
	last_attempt_at: null,
	last_http_status: null,
	last_outcome: null,
	completed_at: null,
} satisfies JsonWebhookDelivery

const endpointPath = `/v1/webhooks/${webhook.id}`
const listPath = `${endpointPath}/deliveries`
const app = async (url: string, queryClient = newQueryClient()) => {
	const router = createRouter({
		routeTree,
		context: { queryClient },
		history: createMemoryHistory({ initialEntries: [url] }),
	})
	const page = render(
		<QueryClientProvider client={queryClient}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	)
	await act(() => router.load())
	return page
}

afterEach(() => vi.unstubAllGlobals())

it("keeps independent cursors and renders only the permitted endpoint and delivery fields", async () => {
	const historyCursor = "opaque history/+"
	const directoryCursor = "opaque directory/+"
	const sent = stubApi(({ path }) => {
		const url = new URL(path, "http://dashboard.test")
		if (path === "/auth/session") {
			return { body: { authenticated: true } }
		}
		if (url.pathname === "/v1/webhooks") {
			return url.searchParams.get("page") === directoryCursor
				? { body: { data: [webhook], next_page: null } }
				: { body: { data: [], next_page: directoryCursor } }
		}
		if (path === endpointPath) {
			return { body: webhook }
		}
		if (url.pathname === listPath) {
			return url.searchParams.get("page") === historyCursor
				? { body: { data: [delivery], next_page: null } }
				: { body: { data: [later], next_page: historyCursor } }
		}
		if (path === `${listPath}/${delivery.id}`) {
			return { body: delivery }
		}
		return { status: 404, body: { error: { message: "Missing." } } }
	})
	const page = await app("/webhooks")
	try {
		fireEvent.click(await page.findByRole("button", { name: "Load more endpoints" }))
		expect(page.queryByText("No webhook endpoints.")).toBeNull()
		fireEvent.click(await page.findByRole("link", { name: /hooks.example.test/ }))
		expect(await page.findByText("Queued")).toBeTruthy()
		expect(await page.findByText("Status Paused")).toBeTruthy()
		fireEvent.click(await page.findByRole("button", { name: "Load earlier deliveries" }))
		expect(await page.findByText(delivery.id)).toBeTruthy()
		expect(await page.findByText(later.id)).toBeTruthy()
		fireEvent.click(await page.findByRole("link", { name: new RegExp(delivery.id) }))
		expect(await page.findByText("HTTP 503")).toBeTruthy()
		expect(page.container.textContent).toContain("Receiver error")
		expect(page.container.textContent).toContain(delivery.event_id)
		expect(page.container.textContent).not.toMatch(/private-path|private-query|private-error/)
		expect(page.getByRole("heading", { level: 1 })).toBe(document.activeElement)
		const parsed = sent.map(({ path, method }) => ({
			method,
			url: new URL(path, "http://dashboard.test"),
		}))
		expect(parsed.every(({ method }) => method === "GET")).toBe(true)
		expect(
			parsed.find(({ url }) => url.searchParams.get("page") === directoryCursor)?.url.pathname,
		).toBe("/v1/webhooks")
		expect(
			parsed.find(({ url }) => url.searchParams.get("page") === historyCursor)?.url.pathname,
		).toBe(listPath)
	} finally {
		page.unmount()
	}
})

it("explains a delivery 404 under the requested endpoint", async () => {
	stubApi(({ path }) =>
		path === endpointPath
			? { body: webhook }
			: path === "/auth/session"
				? { body: {} }
				: { status: 404, body: { error: { message: "Missing." } } },
	)
	const page = await app(`/webhooks/${webhook.id}/deliveries/wdel_expired`)
	try {
		expect((await page.findByRole("alert")).textContent).toContain("Delivery unavailable")
		expect(
			page
				.getAllByRole("link", { name: "Delivery history" })
				.every((link) => link.getAttribute("href") === `/webhooks/${webhook.id}`),
		).toBe(true)
	} finally {
		page.unmount()
	}
})

it("hides cached delivery and destination details when the endpoint disappears", async () => {
	const queryClient = newQueryClient()
	queryClient.setQueryData(webhookQuery(webhook.id).queryKey, webhook)
	queryClient.setQueryData(webhookDeliveryQuery(webhook.id, delivery.id).queryKey, delivery)
	await queryClient.invalidateQueries({
		queryKey: webhookQuery(webhook.id).queryKey,
		refetchType: "none",
	})
	stubApi(({ path }) =>
		path === endpointPath
			? { status: 404, body: { error: { message: "Missing." } } }
			: { body: path === "/auth/session" ? {} : delivery },
	)
	const page = await app("/webhooks/" + webhook.id + "/deliveries/" + delivery.id, queryClient)
	try {
		expect((await page.findByRole("alert")).textContent).toContain("Delivery unavailable")
		expect(page.container.textContent).not.toContain("hooks.example.test")
		expect(page.container.textContent).not.toContain(delivery.event_id)
	} finally {
		page.unmount()
	}
})

it("hides the cached destination heading when the endpoint disappears", async () => {
	const queryClient = newQueryClient()
	queryClient.setQueryData(webhookQuery(webhook.id).queryKey, webhook)
	await queryClient.invalidateQueries({
		queryKey: webhookQuery(webhook.id).queryKey,
		refetchType: "none",
	})
	stubApi(({ path }) =>
		path === endpointPath
			? { status: 404, body: { error: { message: "Missing." } } }
			: { body: path === "/auth/session" ? {} : { data: [], next_page: null } },
	)
	const page = await app("/webhooks/" + webhook.id, queryClient)
	try {
		expect((await page.findByRole("alert")).textContent).toContain("Webhook endpoint unavailable.")
		expect(page.getByRole("heading", { level: 1 }).textContent).toBe("Webhook endpoint")
		expect(page.container.textContent).not.toContain("hooks.example.test")
	} finally {
		page.unmount()
	}
})
