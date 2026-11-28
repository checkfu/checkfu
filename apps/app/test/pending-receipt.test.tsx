// @vitest-environment happy-dom
import { waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { ActionReceipt } from "../src/action-receipt.tsx"
import { AcceptedReceipt, ApiError, checkfu, isAcceptedReceipt } from "../src/api.ts"
import { button, click, mount, stubApi } from "./dom.tsx"

const id = "agent_pending"
const model = "fixture-model"
const body = { name: "Fixture", model }
const whenMissing = (status: number) => ({
	status,
	body: { error: { type: "not_found_error", message: "Read not ready." } },
})
const complete = {
	id,
	type: "agent",
	version: 1,
	name: body.name,
	model: { type: "model", id: model },
}

afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllGlobals()
})

it.each([[404], [503], [404, 503]])(
	"retains an accepted agent ID through unavailable reads (%j)",
	async (...statuses) => {
		vi.useFakeTimers()
		let passed = 0
		const sent = stubApi(({ method }) =>
			method === "POST"
				? { status: 202, body: { id, pending: true } }
				: whenMissing(statuses[passed++ % statuses.length] ?? 404),
		)
		const pending = checkfu.agents.create(body, "fixture-key").catch((error: unknown) => error)
		await vi.runAllTimersAsync()
		const receipt = await pending
		expect(receipt).toBeInstanceOf(AcceptedReceipt)
		expect(receipt).toMatchObject({ id, message: expect.stringContaining(id) })
		expect(sent.filter(({ method }) => method === "POST")).toHaveLength(1)
		expect(sent.filter(({ method }) => method === "GET")).toHaveLength(41)
		expect(sent.at(-1)?.path).toBe(`/v1/agents/${id}`)
	},
)

it("keeps the receipt after reads return a stale version", async () => {
	vi.useFakeTimers()
	let visibleVersion = 1
	const sent = stubApi(({ method }) =>
		method === "POST" || method === "PUT" || method === "PATCH"
			? { status: 202, body: { id, type: "agent", version: 2, pending: true } }
			: { body: { ...complete, version: visibleVersion } },
	)
	const pending = checkfu.agents
		.update(id, { version: 1, name: "Updated" })
		.catch((error: unknown) => error)
	await vi.runAllTimersAsync()
	const receipt = await pending
	if (!isAcceptedReceipt(receipt)) {
		throw new Error("Missing acceptance receipt")
	}
	expect(receipt).toMatchObject({ id, message: expect.stringContaining("Change accepted") })
	expect(sent.filter(({ method }) => method === "GET")).toHaveLength(41)
	await expect(receipt.check()).resolves.toBe(false)
	visibleVersion = 2
	await expect(receipt.check()).resolves.toBe(true)
	expect(sent.filter(({ method }) => method === "GET")).toHaveLength(43)
	expect(sent.filter(({ method }) => method !== "GET")).toHaveLength(1)
})

it("can recheck an accepted receipt without repeating the original POST", async () => {
	let visible = false
	const sent = stubApi(({ method }) =>
		method === "POST"
			? { status: 202, body: { id, pending: true } }
			: visible
				? { body: complete }
				: whenMissing(401),
	)
	const result = await checkfu.agents.create(body, "fixture-key").catch((error: unknown) => error)
	if (!isAcceptedReceipt(result)) {
		throw new Error("Missing acceptance receipt")
	}
	expect(result.cause).toBeInstanceOf(ApiError)
	expect(result.cause).toMatchObject({ status: 401 })
	const page = await mount(
		<ActionReceipt receipt={result} href={(agentId) => `/agents/${agentId}`} />,
	)
	try {
		expect(page.container.textContent).toContain(id)
		expect(page.container.textContent).toContain("Sign in again")
		await click(button(page.container, "Check change"))
		await waitFor(() => expect(page.container.textContent).toContain("Sign in again"))
		visible = true
		await click(button(page.container, "Check change"))
		await waitFor(() =>
			expect(page.container.querySelector("a")?.getAttribute("href")).toBe(`/agents/${id}`),
		)
		expect(sent.map(({ method }) => method)).toEqual(["POST", "GET", "GET", "GET"])
	} finally {
		page.unmount()
	}
})

it("distinguishes an initial refusal and waits for a successful later read in the same submit", async () => {
	const refused = stubApi(() => ({ status: 400, body: { error: { message: "Rejected." } } }))
	await expect(checkfu.agents.create(body, "fixture-key")).rejects.toMatchObject({ status: 400 })
	expect(refused.map(({ method }) => method)).toEqual(["POST"])

	vi.useFakeTimers()
	let first = true
	const accepted = stubApi(({ method }) => {
		if (method === "POST") {
			return { status: 202, body: { id, pending: true } }
		}
		if (first) {
			first = false
			return whenMissing(404)
		}
		return { body: complete }
	})
	const pending = checkfu.agents.create(body, "new-fixture-key")
	await vi.runAllTimersAsync()
	expect(await pending).toMatchObject({ id })
	expect(accepted.map(({ method }) => method)).toEqual(["POST", "GET", "GET"])
})
