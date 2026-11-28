// @vitest-environment happy-dom
import { onlineManager } from "@tanstack/react-query"
import { act, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import type { JsonSessionOutputs } from "../src/api.ts"
import { SessionFiles } from "../src/pages/session-files.tsx"
import { button, click, mount, newQueryClient, stubApi } from "./dom.tsx"

const sessionId = "sess_record"
const path = `/v1/sessions/${sessionId}/outputs`
const at = "2026-11-28T00:00:00Z"
const file = {
	id: "file_report",
	type: "file",
	filename: "résumé.csv",
	content_type: "text/csv",
	size: 41,
	sha256: "a".repeat(64),
	origin: { type: "session", session_id: sessionId, turn: 2, path: "reports/résumé.csv" },
	created_at: at,
} satisfies JsonSessionOutputs["files"][number]
const none = {
	type: "session_outputs",
	session_id: sessionId,
	status: "none",
	turn: 0,
	reason: null,
	recorded_at: null,
	files: [],
	skipped: [],
} satisfies JsonSessionOutputs
const saved = {
	...none,
	status: "saved",
	turn: 3,
	files: [file],
	recorded_at: at,
	skipped: [{ path: "huge.log", reason: "Larger than 1048576 bytes." }],
} satisfies JsonSessionOutputs

afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})

it.each([
	{ result: none, text: "No files saved yet." },
	{ result: { ...saved, files: [] }, text: "No saved files are available." },
	{ result: saved, text: "Saved in turn 3" },
])("shows the saved-file result for $text", async ({ result, text }) => {
	stubApi(() => ({ body: result }))
	const page = await mount(<SessionFiles sessionId={sessionId} turn={0} recovery={0} />)
	try {
		await waitFor(() => expect(page.container.textContent).toContain(text))
		if (result.files.length > 0) {
			expect(page.container.textContent).toContain("41 B · Turn 2 · reports/résumé.csv")
			expect(page.container.textContent).toContain("huge.log · Larger than 1048576 bytes.")
			expect(page.container.querySelector("time")?.getAttribute("datetime")).toBe(at)
		}
	} finally {
		page.unmount()
	}
})

it("keeps the prior file tied to its own turn when a later capture is skipped", async () => {
	stubApi(() => ({
		body: {
			...saved,
			status: "skipped",
			turn: 7,
			reason: "The output directory disappeared.",
			skipped: [],
		},
	}))
	const page = await mount(<SessionFiles sessionId={sessionId} turn={7} recovery={0} />)
	try {
		await waitFor(() => expect(page.container.textContent).toContain("Capture skipped in turn 7"))
		expect(page.container.textContent).toContain("The output directory disappeared.")
		expect(page.container.textContent).toContain("Previously saved files")
		expect(page.container.textContent).toContain("41 B · Turn 2 · reports/résumé.csv")
	} finally {
		page.unmount()
	}
})

it("retains files while capture catches up and stops after five background checks", async () => {
	let outcome: JsonSessionOutputs = saved
	const sent = stubApi(() => ({ body: outcome }))
	const page = await mount(<SessionFiles sessionId={sessionId} turn={4} recovery={0} />)
	try {
		await waitFor(() => expect(sent).toHaveLength(6), { timeout: 3500 })
		expect(page.container.textContent).toContain("résumé.csv")
		outcome = { ...saved, turn: 4, files: [] }
		await click(button(page.container, "Refresh files"))
		await waitFor(() => expect(page.container.textContent).toContain("Saved in turn 4"))
		expect(page.container.textContent).toContain("No saved files are available.")
		expect(sent.map((request) => request.path)).toEqual(Array.from({ length: 7 }, () => path))
	} finally {
		page.unmount()
	}
})

it("cancels the output read when the session page closes", async () => {
	let signal: AbortSignal | null | undefined
	vi.stubGlobal("fetch", (_input: string, init: RequestInit) => {
		signal = init.signal
		return new Promise<Response>((_resolve, reject) => {
			signal?.addEventListener("abort", () => reject(signal?.reason), { once: true })
		})
	})
	const page = await mount(<SessionFiles sessionId={sessionId} turn={4} recovery={0} />)
	expect(page.container.textContent).toContain("Loading saved files")
	expect(signal?.aborted).toBe(false)
	page.unmount()
	expect(signal?.aborted).toBe(true)
})

it("uses HEAD before a native download and handles failed checks independently", async () => {
	const url = `/v1/files/${file.id}/content`
	const downloads: Array<{ href: string | null; suggested: string }> = []
	vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
		this: HTMLAnchorElement,
	) {
		downloads.push({ href: this.getAttribute("href"), suggested: this.download })
	})
	const statuses = [503, 401, 200, 404]
	let outcome: JsonSessionOutputs = saved
	const sent = stubApi(({ path, method }) => {
		if (method === "HEAD" && path === url) {
			const status = statuses.shift() ?? 500
			if (status === 404) {
				outcome = { ...saved, files: [] }
			}
			return { status, body: {} }
		}
		return { body: outcome }
	})
	const page = await mount(<SessionFiles sessionId={sessionId} turn={0} recovery={0} />)
	const download = () => {
		const control = page.container.querySelector<HTMLButtonElement>(
			`[aria-label="Download ${file.filename}"]`,
		)
		if (control === null) {
			throw new Error("Missing download action.")
		}
		return click(control)
	}
	try {
		await waitFor(() => expect(page.container.textContent).toContain(file.filename))
		await download()
		expect(page.container.textContent).toContain("Could not check résumé.csv.")
		await download()
		expect(page.container.textContent).toContain("Sign in again to download saved files.")
		expect(downloads).toEqual([])
		await download()
		expect(downloads).toEqual([{ href: url, suggested: "" }])
		await download()
		await waitFor(() =>
			expect(page.container.textContent).toContain("No saved files are available."),
		)
		expect(page.container.textContent).toContain("résumé.csv is no longer available.")
		expect(downloads).toHaveLength(1)
		expect(sent.filter(({ method }) => method === "HEAD").map((request) => request.path)).toEqual([
			url,
			url,
			url,
			url,
		])
	} finally {
		page.unmount()
	}
})

it("discards a download queued while offline if the operator leaves the session", async () => {
	const sent = stubApi(() => ({ body: saved }))
	const download = vi
		.spyOn(HTMLAnchorElement.prototype, "click")
		.mockImplementation(() => undefined)
	const client = newQueryClient()
	const page = await mount(<SessionFiles sessionId={sessionId} turn={0} recovery={0} />, client)
	try {
		await waitFor(() => expect(page.container.textContent).toContain(file.filename))
		await act(async () => {
			onlineManager.setOnline(false)
		})
		const control = page.container.querySelector<HTMLButtonElement>(
			`[aria-label="Download ${file.filename}"]`,
		)
		if (control === null) {
			throw new Error("Missing download action.")
		}
		await click(control)
		expect(sent.filter(({ method }) => method === "HEAD")).toHaveLength(0)
		page.unmount()
		await act(async () => {
			onlineManager.setOnline(true)
			await client.resumePausedMutations()
		})
		expect(sent.filter(({ method }) => method === "HEAD")).toHaveLength(0)
		expect(download).not.toHaveBeenCalled()
	} finally {
		onlineManager.setOnline(true)
	}
})

it("reports a malformed capture response without interrupting the session view", async () => {
	stubApi(() => ({ body: { type: "session", id: sessionId } }))
	const page = await mount(<SessionFiles sessionId={sessionId} turn={0} recovery={0} />)
	try {
		await waitFor(() => expect(page.container.textContent).toContain("Could not load saved files."))
		expect(button(page.container, "Retry files")).toBeDefined()
	} finally {
		page.unmount()
	}
})
