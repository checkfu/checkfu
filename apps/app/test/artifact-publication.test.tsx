// @vitest-environment happy-dom
import type { JsonArtifact } from "@checkfu/sdk/client"
import { QueryClientProvider } from "@tanstack/react-query"
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router"
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react"
import { act } from "react"
import { afterEach, expect, it, vi } from "vitest"
import { routeTree } from "../src/routeTree.gen.ts"
import { button, click, newQueryClient, settle, stubApi } from "./dom.tsx"

const artifactPath = "/v1/artifacts/art_1"
const publicationPath = `${artifactPath}/publication`
const url = "https://example.test/p/public_report/"
const at = "2026-11-27T00:00:00.000Z"

const open = async ({ refuse = false, failRefresh = false } = {}) => {
	let artifact: JsonArtifact = {
		id: "art_1",
		type: "artifact",
		name: "Public report",
		version: 3,
		capabilities: {},
		made_from: null,
		file_count: 0,
		total_bytes: 0,
		files: [],
		publication: {
			address: "public_report",
			url,
			version: 1,
			access: "view" as const,
			grants: {},
			published_at: at,
		},
		created_at: at,
		updated_at: at,
	}
	const completePublish = Promise.withResolvers<void>()
	const completeUnpublish = Promise.withResolvers<void>()
	const started: Array<string> = []
	const sent = stubApi(({ path, method, body }) => {
		if (path === "/auth/session") {
			return { body: {} }
		}
		if (path === artifactPath && method === "GET") {
			return failRefresh && artifact.publication === null
				? { status: 503, body: { error: { type: "api_error", message: "Refresh failed." } } }
				: { body: artifact }
		}
		if (path.startsWith("/v1/artifacts?") && method === "GET") {
			return {
				body: { data: [artifact], next_page: null },
			}
		}
		if (path === publicationPath && method === "POST") {
			if (refuse) {
				return {
					status: 409,
					body: { error: { type: "conflict_error", message: "Publication changed." } },
				}
			}
			const target =
				typeof body === "object" && body !== null && "version" in body ? body.version : undefined
			const version = target === "latest" ? null : target
			if ((version !== null && typeof version !== "number") || artifact.publication === null) {
				throw new Error("Expected the existing publication and its new target")
			}
			artifact = { ...artifact, publication: { ...artifact.publication, version } }
			return { body: artifact }
		}
		if (path === publicationPath && method === "DELETE") {
			artifact = { ...artifact, publication: null }
			return { body: artifact }
		}
		throw new Error(`Unexpected ${method} ${path}`)
	})
	const respond = globalThis.fetch
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		if (input === publicationPath) {
			const method = init?.method ?? "GET"
			started.push(method)
			await (method === "POST" ? completePublish.promise : completeUnpublish.promise)
		}
		return respond(input, init)
	})
	const queryClient = newQueryClient()
	const router = createRouter({
		routeTree,
		context: { queryClient },
		history: createMemoryHistory({ initialEntries: ["/artifacts/art_1"] }),
	})
	const page = render(
		<QueryClientProvider client={queryClient}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	)
	await act(async () => {
		await router.load()
	})
	await settle()
	return {
		...page,
		router,
		started,
		completePublish: completePublish.resolve,
		completeUnpublish: completeUnpublish.resolve,
		changes: () =>
			sent
				.filter(({ path }) => path === publicationPath)
				.map(({ method, body }) => ({ method, body })),
	}
}

afterEach(() => {
	cleanup()
	vi.unstubAllGlobals()
})

it.each([
	{ label: "Pin to v3", target: 3, result: "v3, pinned" },
	{ label: "Follow latest", target: "latest", result: "The latest version, now v3" },
])("waits for $label before it can confirm an unpublish", async ({ label, target, result }) => {
	const page = await open()
	const unpublish = () => button(page.container, "Unpublish")
	await act(async () => {
		button(page.container, label).click()
		unpublish().click()
	})
	await waitFor(() => expect(page.started).toEqual(["POST"]))
	for (const name of ["Pin to v3", "Follow latest", "Unpublish"]) {
		const control = button(page.container, name)
		expect(control.disabled).toBe(true)
		await act(async () => {
			fireEvent.keyDown(control, { key: "Enter" })
			control.click()
		})
	}
	expect(page.started).toEqual(["POST"])
	expect(page.container.textContent).not.toContain("Its address stops working")
	await act(async () => page.completePublish())
	await waitFor(() => expect(page.container.textContent).toContain(result))
	await click(unpublish())
	await act(async () => {
		const confirm = unpublish()
		button(page.container, "Cancel").click()
		confirm.click()
	})
	expect(page.started).toEqual(["POST"])
	await click(unpublish())
	await act(async () => {
		unpublish().click()
		button(page.container, "Cancel").click()
	})
	await waitFor(() => expect(page.started).toEqual(["POST", "DELETE"]))
	expect(unpublish().disabled).toBe(true)
	expect(button(page.container, "Cancel").disabled).toBe(true)
	await act(async () => page.completeUnpublish())
	await waitFor(() => expect(page.container.textContent).toContain("Not published."))
	expect(page.container.textContent).not.toContain(url)
	expect(page.changes()).toEqual([
		{ method: "POST", body: { version: target } },
		{ method: "DELETE", body: undefined },
	])
})

it("keeps the prior publication and restores every control after a failed change", async () => {
	const page = await open({ refuse: true })
	await click(button(page.container, "Pin to v3"))
	await waitFor(() => expect(page.started).toEqual(["POST"]))
	expect(button(page.container, "Unpublish").disabled).toBe(true)
	await act(async () => page.completePublish())
	await waitFor(() =>
		expect(page.container.querySelector('[role="alert"]')?.textContent).toContain(
			"Publication changed.",
		),
	)
	expect(page.container.textContent).toContain("v1, pinned")
	expect(page.container.textContent).toContain(url)
	for (const label of ["Pin to v3", "Follow latest", "Unpublish"]) {
		expect(button(page.container, label).disabled).toBe(false)
	}
	expect(page.started).toEqual(["POST"])
})

it("keeps publication busy when the artifact is reopened in the same dashboard", async () => {
	const page = await open()
	await click(button(page.container, "Pin to v3"))
	await waitFor(() => expect(page.started).toEqual(["POST"]))
	await act(async () => {
		await page.router.navigate({ to: "/artifacts" })
	})
	await waitFor(() => expect(page.container.textContent).toContain("Versioned sets of files"))
	await act(async () => {
		await page.router.navigate({ to: "/artifacts/$artifactId", params: { artifactId: "art_1" } })
	})
	const follow = button(page.container, "Follow latest")
	expect(follow.disabled).toBe(true)
	await click(follow)
	expect(page.started).toEqual(["POST"])
	await act(async () => page.completePublish())
	await waitFor(() => expect(button(page.container, "Follow latest").disabled).toBe(false))
	expect(page.container.textContent).toContain("v3, pinned")
})

it("removes a revoked address even if the detail refresh fails", async () => {
	const page = await open({ failRefresh: true })
	await click(button(page.container, "Unpublish"))
	await click(button(page.container, "Unpublish"))
	await waitFor(() => expect(page.started).toEqual(["DELETE"]))
	await act(async () => page.completeUnpublish())
	await waitFor(() => expect(button(page.container, "Publish").disabled).toBe(false))
	expect(page.container.textContent).toContain("Not published.")
	expect(page.container.textContent).not.toContain(url)
})
