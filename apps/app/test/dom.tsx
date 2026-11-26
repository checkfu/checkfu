import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router"
import { act } from "react"
import type * as React from "react"
import { createRoot } from "react-dom/client"
import { vi } from "vitest"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

export interface Request {
	readonly method: string
	readonly path: string
	readonly body: unknown
	readonly headers: Headers
}

export const stubApi = (
	reply: (request: Request) => { readonly status?: number; readonly body: unknown },
): ReadonlyArray<Request> => {
	const sent: Array<Request> = []
	vi.stubGlobal("fetch", async (path: string, init: RequestInit = {}) => {
		const sentBody: unknown = typeof init.body === "string" ? JSON.parse(init.body) : undefined
		const request = {
			method: init.method ?? "GET",
			path,
			body: sentBody,
			headers: new Headers(init.headers),
		}
		sent.push(request)
		const { status = 200, body } = reply(request)
		return new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		})
	})
	return sent
}

export const newQueryClient = (): QueryClient =>
	new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })

export const mount = async (ui: React.ReactNode, queryClient: QueryClient = newQueryClient()) => {
	const router = createRouter({
		routeTree: createRootRoute({ component: () => ui }),
		history: createMemoryHistory({ initialEntries: ["/"] }),
	})
	const container = document.createElement("div")
	document.body.append(container)
	const root = createRoot(container)
	await act(async () => {
		root.render(
			<QueryClientProvider client={queryClient}>
				<RouterProvider router={router} />
			</QueryClientProvider>,
		)
		await router.load()
	})
	return {
		container,
		router,
		queryClient,
		unmount: () => {
			act(() => root.unmount())
			container.remove()
		},
	}
}

export const settle = async (): Promise<void> => {
	for (let round = 0; round < 10; round++) {
		await act(async () => {
			await new Promise((resolve) => {
				setTimeout(resolve, 0)
			})
		})
	}
}

export const type = async (
	element: HTMLInputElement | HTMLTextAreaElement | null,
	value: string,
): Promise<void> => {
	if (element === null) {
		throw new Error("No such field.")
	}
	await act(async () => {
		Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set?.call(
			element,
			value,
		)
		element.dispatchEvent(new Event("input", { bubbles: true }))
	})
}

export const button = (container: HTMLElement, text: string): HTMLButtonElement => {
	const found = [...container.querySelectorAll("button")].find(
		(candidate) => candidate.textContent?.trim() === text,
	)
	if (found === undefined) {
		throw new Error(`No button "${text}" in: ${container.textContent ?? ""}`)
	}
	return found
}

export const click = async (element: HTMLElement): Promise<void> => {
	await act(async () => {
		element.click()
	})
	await settle()
}

export const submit = async (form: HTMLFormElement | null | undefined): Promise<void> => {
	if (form === null || form === undefined) {
		throw new Error("No such form.")
	}
	await act(async () => {
		form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
	})
	await settle()
}
