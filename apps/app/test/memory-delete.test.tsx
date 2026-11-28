// @vitest-environment happy-dom
import type { JsonMemory, JsonMemoryStore } from "@checkfu/sdk/client"
import { QueryClientProvider } from "@tanstack/react-query"
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router"
import { cleanup, render } from "@testing-library/react"
import { act } from "react"
import { afterEach, expect, it, vi } from "vitest"
import { memoryQuery } from "../src/queries.ts"
import { routeTree } from "../src/routeTree.gen.ts"
import { button, click, newQueryClient, settle, stubApi } from "./dom.tsx"

const storeUrl = "/memory-stores/mstore_1"
const memoryUrl = `${storeUrl}/memories/mem_1`
const storePath = "/v1/memory_stores/mstore_1"
const memoryPath = `${storePath}/memories/mem_1`
const at = "2026-11-27T00:00:00.000Z"
const reviewedDigest = "a".repeat(64)

const openMemory = async () => {
	const store: JsonMemoryStore = {
		id: "mstore_1",
		type: "memory_store",
		name: "Notes",
		description: "",
		created_at: at,
		updated_at: at,
		archived_at: null,
	}
	let memory: JsonMemory = {
		id: "mem_1",
		type: "memory",
		memory_store_id: store.id,
		path: "/notes/style.md",
		content: "Earlier content",
		content_sha256: reviewedDigest,
		content_size_bytes: 15,
		version: 1,
		created_at: at,
		updated_at: at,
	}
	const sent = stubApi(({ path, method }) => {
		if (path === "/auth/session") {
			return { body: {} }
		}
		if (path === storePath && method === "GET") {
			return { body: store }
		}
		if (path.split("?")[0] === `${storePath}/memories` && method === "GET") {
			return { body: { data: [], next_page: null } }
		}
		if (path === memoryPath && method === "GET") {
			return { body: memory }
		}
		const [pathname, query] = path.split("?")
		if (pathname === memoryPath && method === "DELETE") {
			return new URLSearchParams(query).get("expected_content_sha256") === memory.content_sha256
				? { body: { id: memory.id, type: "memory_deleted" } }
				: {
						status: 409,
						body: {
							type: "error",
							error: { type: "conflict_error", message: "The saved memory changed." },
						},
					}
		}
		throw new Error(`Unexpected request ${method} ${path}`)
	})
	const queryClient = newQueryClient()
	const router = createRouter({
		routeTree,
		context: { queryClient },
		history: createMemoryHistory({ initialEntries: [memoryUrl] }),
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
		deletions: () => sent.filter(({ method }) => method === "DELETE").map(({ path }) => path),
		updateIndependently: async () => {
			memory = { ...memory, content: "New content", content_sha256: "b".repeat(64), version: 2 }
			await act(async () => {
				await queryClient.invalidateQueries({ queryKey: memoryQuery(store.id, memory.id).queryKey })
			})
			await settle()
		},
	}
}

afterEach(() => {
	cleanup()
	vi.unstubAllGlobals()
})

it("names the reviewed memory and leaves it intact on cancellation", async () => {
	const page = await openMemory()
	const trigger = button(page.container, "Delete")
	await click(trigger)
	const cancel = button(page.container, "Cancel")
	const confirmation = button(page.container, "Delete memory")
	expect(document.activeElement).toBe(cancel)
	const description = confirmation.getAttribute("aria-describedby") ?? ""
	expect(document.getElementById(description)?.textContent).toContain(
		"Permanently delete /notes/style.md? You reviewed v1.",
	)
	expect(page.deletions()).toEqual([])
	await click(cancel)
	expect(document.activeElement).toBe(trigger)
	expect(page.container.textContent).not.toContain("Permanently delete")
	expect(page.deletions()).toEqual([])
	expect(page.router.state.location.pathname).toBe(memoryUrl)
})

it("confirms one guarded delete and returns to the store", async () => {
	const page = await openMemory()
	await click(button(page.container, "Delete"))
	const confirm = button(page.container, "Delete memory")
	await act(async () => {
		confirm.click()
		confirm.click()
	})
	await settle()
	expect(page.deletions()).toEqual([`${memoryPath}?expected_content_sha256=${reviewedDigest}`])
	expect(page.router.state.location.pathname).toBe(storeUrl)
})

it("keeps the reviewed digest when the memory changes with confirmation open", async () => {
	const page = await openMemory()
	await click(button(page.container, "Delete"))
	await page.updateIndependently()
	expect(page.container.textContent).toContain(
		"Permanently delete /notes/style.md? You reviewed v1.",
	)
	await click(button(page.container, "Delete memory"))
	expect(page.deletions()).toEqual([`${memoryPath}?expected_content_sha256=${reviewedDigest}`])
	expect(page.router.state.location.pathname).toBe(memoryUrl)
	expect(page.container.textContent).toContain("The saved memory changed.")
})
