// @vitest-environment happy-dom
import type { JsonMemoryStore } from "@checkfu/sdk/client"
import { QueryClientProvider } from "@tanstack/react-query"
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router"
import { cleanup, render, waitFor } from "@testing-library/react"
import { act } from "react"
import { afterEach, expect, it, vi } from "vitest"
import type { JsonMemoryEntry } from "../src/api.ts"
import { routeTree } from "../src/routeTree.gen.ts"
import { button, click, newQueryClient, stubApi, submit, type } from "./dom.tsx"

const at = "2026-11-27T00:00:00.000Z"
const store = {
	id: "mstore_notes",
	type: "memory_store",
	name: "Notes",
	description: "",
	created_at: at,
	updated_at: at,
	archived_at: null,
} satisfies JsonMemoryStore
const endpoint = `/v1/memory_stores/${store.id}`
const memoriesPath = `${endpoint}/memories`

const row = (number: number): JsonMemoryEntry => ({
	id: `mem_${number}`,
	type: "memory",
	memory_store_id: store.id,
	path: `/note-${number}.md`,
	content_sha256: "a".repeat(64),
	content_size_bytes: 12,
	created_at: at,
	updated_at: at,
})

const open = async (
	reply: (cursor: string | null, method: string) => ReturnType<Parameters<typeof stubApi>[0]>,
) => {
	const requested: Array<string | null> = []
	stubApi(({ path, method }) => {
		const url = new URL(path, "https://dashboard.test")
		if (url.pathname === memoriesPath) {
			const cursor = url.searchParams.get("page")
			if (method === "GET") {
				requested.push(cursor)
			}
			return reply(cursor, method)
		}
		if (url.pathname === endpoint) {
			return { body: store }
		}
		if (url.pathname === "/v1/memory_stores") {
			return { body: { data: [store], next_page: null } }
		}
		if (url.pathname === "/auth/session") {
			return { body: {} }
		}
		throw new Error(`Unexpected request ${path}`)
	})
	const queryClient = newQueryClient()
	const router = createRouter({
		routeTree,
		context: { queryClient },
		history: createMemoryHistory({ initialEntries: [`/memory-stores/${store.id}`] }),
	})
	const page = render(
		<QueryClientProvider client={queryClient}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	)
	await act(async () => {
		await router.load()
	})
	await page.findByText("/note-1.md")
	return { ...page, requested, router }
}

afterEach(() => {
	cleanup()
	vi.unstubAllGlobals()
})

it("fetches one page at a time and keeps earlier rows across ten pages", async () => {
	const page = await open((cursor) => {
		const number = cursor === null ? 1 : Number(cursor)
		return { body: { data: [row(number)], next_page: number < 10 ? String(number + 1) : null } }
	})
	expect(page.requested).toEqual([null])
	for (let number = 2; number <= 10; number++) {
		await click(button(page.container, "Load more"))
		expect(page.getByText(`/note-${number}.md`)).toBeDefined()
	}
	expect(page.getByText("/note-1.md")).toBeDefined()
	expect(page.requested).toEqual([null, "2", "3", "4", "5", "6", "7", "8", "9", "10"])
	expect(page.queryByRole("button", { name: "Load more" })).toBeNull()
})

it.each(["missing", "blank", "repeated", "cyclic"] as const)(
	"stops on a %s cursor",
	async (kind) => {
		const page = await open((cursor) => {
			if (kind === "missing") {
				return { body: { data: [row(1)] } }
			}
			if (cursor === null) {
				return { body: { data: [row(1)], next_page: kind === "blank" ? "" : "2" } }
			}
			return {
				body: {
					data: [row(Number(cursor))],
					next_page: kind === "cyclic" && cursor === "2" ? "3" : "2",
				},
			}
		})
		if (kind === "repeated" || kind === "cyclic") {
			await click(button(page.container, "Load more"))
			if (kind === "cyclic") {
				await click(button(page.container, "Load more"))
			}
			expect(page.getByText("Listing stopped because the next page repeated.")).toBeDefined()
		}
		expect(page.queryByRole("button", { name: "Load more" })).toBeNull()
		expect(page.getByText("/note-1.md")).toBeDefined()
		expect(page.requested).toEqual(
			kind === "repeated" ? [null, "2"] : kind === "cyclic" ? [null, "2", "3"] : [null],
		)
	},
)

it("keeps existing rows if a continuation fails and lets the operator retry it", async () => {
	let failed = false
	const page = await open((cursor) => {
		if (cursor === null) {
			return { body: { data: [row(1)], next_page: "2" } }
		}
		if (!failed) {
			failed = true
			return {
				status: 503,
				body: {
					error: { type: "service_unavailable", message: "The list is temporarily unavailable." },
				},
			}
		}
		return { body: { data: [row(2)], next_page: null } }
	})
	await click(button(page.container, "Load more"))
	expect(page.getByText("The list is temporarily unavailable.")).toBeDefined()
	expect(page.getByText("/note-1.md")).toBeDefined()
	await click(button(page.container, "Load more"))
	expect(page.getByText("/note-2.md")).toBeDefined()
	expect(page.requested).toEqual([null, "2", "2"])
})

it("refreshes the open store listing after adding a memory", async () => {
	let created = false
	const page = await open((_cursor, method) => {
		if (method === "POST") {
			created = true
			return { status: 201, body: { ...row(2), content: "Remember it.", version: 1 } }
		}
		return { body: { data: created ? [row(1), row(2)] : [row(1)], next_page: null } }
	})
	await type(page.container.querySelector("input"), "/note-2.md")
	await type(page.container.querySelector("textarea"), "Remember it.")
	await submit(page.container.querySelector("form"))
	expect(await page.findByText("/note-2.md")).toBeDefined()
	expect(page.requested).toEqual([null, null])
})

it("keeps the first row visible while a continuation waits and cancels it on navigation", async () => {
	const page = await open(() => ({ body: { data: [row(1)], next_page: "2" } }))
	const fallback = globalThis.fetch
	let signal: AbortSignal | null | undefined
	vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
		if (String(input).startsWith(memoriesPath)) {
			signal = init?.signal
			return new Promise<Response>((_resolve, reject) => {
				signal?.addEventListener("abort", () => reject(signal?.reason), { once: true })
			})
		}
		return fallback(input, init)
	})
	await click(button(page.container, "Load more"))
	expect(page.getByText("/note-1.md")).toBeDefined()
	expect(button(page.container, "Loading…").disabled).toBe(true)
	expect(signal).toBeDefined()
	await act(async () => {
		await page.router.navigate({ to: "/memory-stores" })
	})
	await waitFor(() => expect(signal?.aborted).toBe(true))
})
