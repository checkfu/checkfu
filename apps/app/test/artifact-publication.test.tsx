// @vitest-environment happy-dom
import { grantAt } from "@checkfu/sdk/ArtifactAccess"
import type { JsonArtifact } from "@checkfu/sdk/client"
import { QueryClientProvider } from "@tanstack/react-query"
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router"
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react"
import { act } from "react"
import { afterEach, expect, it, vi } from "vitest"
import { routeTree } from "../src/routeTree.gen.ts"
import { artifactQuery } from "../src/queries.ts"
import { button, click, newQueryClient, settle, stubApi } from "./dom.tsx"

const artifactPath = "/v1/artifacts/art_1"
const publicationPath = `${artifactPath}/publication`
const linkPath = `${artifactPath}/versions/3/links`
const address = `a1-${"a".repeat(25)}`
const url = `https://example.test/p/${address}/`
const listed = { address, version: 1, access: "view", grants: {} } as const
const samePost = { version: 3, publication: listed }
const responses = (visitors: "add" | "write") => ({
	database: { collections: { responses: { visitors } } },
})
const at = "2026-11-27T00:00:00.000Z"

const open = async ({
	refuse = false,
	failRefresh = false,
	initiallyPublished = true,
	followingWithSavedGrant = false,
} = {}) => {
	let artifact: JsonArtifact = {
		id: "art_1",
		type: "artifact",
		name: "Public report",
		version: 3,
		capabilities: responses(followingWithSavedGrant ? "write" : "add"),
		made_from: null,
		file_count: 0,
		total_bytes: 0,
		files: [],
		publication: initiallyPublished
			? followingWithSavedGrant
				? {
						...listed,
						url,
						version: null,
						access: "write",
						grants: { responses: "add" },
						published_at: at,
					}
				: { ...listed, url, published_at: at }
			: null,
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
		if (path === artifactPath && method === "DELETE") {
			return { body: { id: artifact.id, type: "artifact_deleted" } }
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
		if (path === linkPath && method === "POST") {
			return {
				status: 201,
				body: {
					type: "artifact_link",
					artifact_id: "art_1",
					version: 3,
					url: "https://example.test/a/share/",
					access: "read",
					expires_at: at,
				},
			}
		}
		if (path === `${artifactPath}/versions/1` && method === "GET") {
			return {
				body: {
					type: "artifact_version",
					made_from: null,
					artifact_id: "art_1",
					version: 1,
					capabilities: responses("add"),
					file_count: 0,
					total_bytes: 0,
					files: [],
					created_at: at,
				},
			}
		}
		if (path === publicationPath && method === "POST") {
			const current = artifact.publication
			const expected = {
				version: artifact.version,
				publication:
					current === null
						? null
						: {
								address: current.address,
								version: current.version,
								access: current.access,
								grants: current.grants,
							},
			}
			const condition =
				typeof body === "object" && body !== null && "if_current" in body
					? body.if_current
					: undefined
			if (refuse || JSON.stringify(condition) !== JSON.stringify(expected)) {
				return {
					status: 409,
					body: { error: { type: "conflict_error", message: "Publication changed." } },
				}
			}
			const target =
				typeof body === "object" && body !== null && "version" in body ? body.version : undefined
			const version = target === "latest" ? null : target
			if (version !== null && typeof version !== "number") {
				throw new Error("Expected a publication target")
			}
			const access =
				typeof body === "object" && body !== null && "access" in body ? body.access : undefined
			const publication = artifact.publication ?? {
				address,
				url,
				published_at: at,
				access: "view" as const,
				grants: {},
			}
			const approved: Pick<
				NonNullable<JsonArtifact["publication"]>,
				"access" | "grants"
			> = access === "view" || access === "read" || access === "write"
				? {
						access,
						grants: grantAt(access, version === 1 ? responses("add") : artifact.capabilities),
					}
				: { access: publication.access, grants: publication.grants }
			artifact = { ...artifact, publication: { ...publication, version, ...approved } }
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
		sent,
		started,
		completePublish: completePublish.resolve,
		completeUnpublish: completeUnpublish.resolve,
		setServerPublication: (publication: JsonArtifact["publication"]) => {
			artifact = { ...artifact, publication }
		},
		refresh: async () =>
			act(async () => {
				await queryClient.invalidateQueries({ queryKey: artifactQuery(artifact.id).queryKey })
			}),
		deletions: () =>
			sent.filter(({ path, method }) => path === artifactPath && method === "DELETE").length,
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
		{ method: "POST", body: { version: target, if_current: samePost } },
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

it("describes erasure of every version and database document before deletion", async () => {
	const page = await open()
	await click(button(page.container, "Delete"))
	expect(page.container.textContent).toContain(
		"every version of its files, and all documents in its database",
	)
	expect(page.container.textContent).toContain(
		"Its public address and every viewing link stop working",
	)
	await click(button(page.container, "Cancel"))
	expect(page.deletions()).toBe(0)
	await click(button(page.container, "Delete"))
	await click(button(page.container, "Delete artifact"))
	await waitFor(() => expect(page.deletions()).toBe(1))
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

it("creates an expiring link with the selected data access", async () => {
	const page = await open()
	fireEvent.change(page.getByLabelText("Link data access"), { target: { value: "read" } })
	await click(button(page.container, "Create link"))
	await waitFor(() =>
		expect(page.getByText(/Link ready for v3/).textContent).toContain("Allow data reads"),
	)
	expect(page.sent.filter(({ path }) => path === linkPath)).toMatchObject([
		{ method: "POST", body: { expires_in: 3600, access: "read" } },
	])
	expect(page.container.textContent).toContain("https://example.test/a/share/")
})

it("can publish with write access, repin without widening it, and revoke data access in place", async () => {
	const page = await open({ initiallyPublished: false })
	fireEvent.change(page.getByLabelText("Public data access"), { target: { value: "write" } })
	await click(button(page.container, "Publish"))
	await act(async () => page.completePublish())
	await waitFor(() => expect(page.container.textContent).toContain("responses · Add only"))
	await click(button(page.container, "Pin to v3"))
	await waitFor(() => expect(page.container.textContent).toContain("v3, pinned"))
	expect(page.container.textContent).toContain("responses · Add only")
	fireEvent.change(page.getByLabelText("Public data access"), { target: { value: "view" } })
	await click(button(page.container, "Apply access"))
	await waitFor(() => expect(page.container.textContent).not.toContain("responses · Add only"))
	expect(page.container.textContent).toContain(url)
	expect(page.changes()).toEqual([
		{
			method: "POST",
			body: { version: "latest", access: "write", if_current: { version: 3, publication: null } },
		},
		{
			method: "POST",
			body: {
				version: 3,
				if_current: {
					version: 3,
					publication: { address, version: null, access: "write", grants: { responses: "add" } },
				},
			},
		},
		{
			method: "POST",
			body: {
				version: 3,
				access: "view",
				if_current: {
					version: 3,
					publication: { address, version: 3, access: "write", grants: { responses: "add" } },
				},
			},
		},
	])
})

it("shows expanded grants before approving the same level on the latest version", async () => {
	const page = await open({ followingWithSavedGrant: true })
	expect(page.container.textContent).toContain("responses · Add only")
	expect(page.getByText(/Proposed grants for v3/).textContent).toContain(
		"responses · Read and write",
	)
	expect(page.changes()).toEqual([])
	await click(button(page.container, "Approve updated grants"))
	await act(async () => page.completePublish())
	await waitFor(() =>
		expect(page.getByText("Public data access updated.").getAttribute("role")).toBe("status"),
	)
	expect(page.container.textContent).not.toContain("responses · Add only")
	expect(button(page.container, "Apply access").disabled).toBe(true)
})

it("keeps a reviewed grant from publishing again if its address is removed concurrently", async () => {
	const page = await open({ followingWithSavedGrant: true })
	await click(button(page.container, "Approve updated grants"))
	await waitFor(() => expect(page.started).toEqual(["POST"]))
	page.setServerPublication(null)
	await act(async () => page.completePublish())
	await waitFor(() => expect(page.getByRole("alert").textContent).toContain("Publication changed."))
	await page.refresh()
	await waitFor(() => expect(page.container.textContent).toContain("Not published."))
	expect(page.container.textContent).not.toContain(url)
})

it("drops an unsubmitted grant when the publication address changes", async () => {
	const page = await open({ followingWithSavedGrant: true })
	fireEvent.change(page.getByLabelText("Public data access"), { target: { value: "view" } })
	expect(button(page.container, "Apply access").disabled).toBe(false)
	const replacement = `a1-${"b".repeat(25)}`
	page.setServerPublication({
		address: replacement,
		url: `https://example.test/p/${replacement}/`,
		version: null,
		access: "write",
		grants: { responses: "write" },
		published_at: at,
	})
	await page.refresh()
	await waitFor(() =>
		expect(page.getByRole("option", { name: "Allow data writes", selected: true })).toBeDefined(),
	)
	expect(button(page.container, "Apply access").disabled).toBe(true)
	expect(page.changes()).toEqual([])
})
