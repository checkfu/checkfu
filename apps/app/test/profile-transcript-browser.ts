import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createReadStream } from "node:fs"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { createServer } from "node:http"
import type { ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { extname, join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import type { JsonSessionEvent } from "@checkfu/sdk/client"
import {
	appendBatch,
	historyRowCount,
	historyRowMarkers,
	makeTranscriptFixture,
	previewEvents,
	renderedRowMarker,
	reply,
	rowLabel,
	transcriptSession,
	transcriptSizes,
	waitingCallId,
	waitingCallName,
} from "./transcript-fixture.ts"

const dist = resolve(import.meta.dirname, "../dist")
const sessionPath = `/v1/sessions/${transcriptSession.id}`
const chrome = process.env["CHROME_PATH"]
const retryMs = 100
const contentTypes = new Map([
	[".css", "text/css"],
	[".html", "text/html"],
	[".js", "text/javascript"],
	[".svg", "image/svg+xml"],
	[".woff2", "font/woff2"],
])

const until = async <A>(attempt: () => A | Promise<A>, label: string): Promise<NonNullable<A>> => {
	const stop = performance.now() + 20_000
	while (performance.now() < stop) {
		const value = await attempt()
		if (value !== null && value !== undefined && value !== false) {
			return value
		}
		await delay(10)
	}
	throw new Error(`Timed out waiting for ${label}.`)
}

const streamEvents = (
	current: ServerResponse,
	events: ReadonlyArray<{ readonly type: string; readonly seq?: number }>,
) => {
	current.write(
		events
			.map(
				(event) =>
					`${event.seq === undefined ? "" : `id: ${event.seq}\n`}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
			)
			.join(""),
	)
}

const fixtureServer = () => {
	let fixture = makeTranscriptFixture(100)
	let active: ServerResponse | undefined
	let resumeId: string | undefined
	let opened = 0
	let openedAt = 0
	const answers: Array<unknown> = []
	const http = createServer((request, response) => {
		void (async () => {
			const url = new URL(request.url ?? "/", "http://127.0.0.1")
			switch (url.pathname) {
				case "/auth/session":
					response.writeHead(204).end()
					return
				case sessionPath:
					response.setHeader("content-type", "application/json")
					response.end(JSON.stringify(transcriptSession))
					return
				case `${sessionPath}/events`: {
					response.setHeader("content-type", "application/json")
					if (request.method === "POST") {
						request.setEncoding("utf8")
						const chunks: Array<string> = []
						for await (const chunk of request) {
							if (typeof chunk !== "string") {
								throw new Error("Expected a decoded request body.")
							}
							chunks.push(chunk)
						}
						answers.push(JSON.parse(chunks.join("")) as unknown)
						response.end("{}")
						return
					}
					const cursor = url.searchParams.get("page")
					response.end(JSON.stringify(fixture.page(cursor === null ? undefined : Number(cursor))))
					return
				}
				case `${sessionPath}/events/stream`: {
					openedAt = performance.now()
					assert.equal(url.searchParams.get("after"), String(fixture.newest))
					const lastEventId = request.headers["last-event-id"]
					resumeId = typeof lastEventId === "string" ? lastEventId : undefined
					opened++
					active = response
					response.writeHead(200, {
						"content-type": "text/event-stream",
						"cache-control": "no-cache",
					})
					response.write(`retry: ${retryMs}\n\n`)
					return
				}
				default: {
					const asset = /^\/assets\/[\w.-]+$/u.test(url.pathname)
					const file = asset ? join(dist, url.pathname) : join(dist, "index.html")
					const info = await stat(file)
					response.writeHead(200, {
						"content-length": info.size,
						"content-type": contentTypes.get(extname(file)) ?? "application/octet-stream",
					})
					createReadStream(file).pipe(response)
				}
			}
		})().catch((error: unknown) => {
			response.statusCode = 500
			response.end(String(error))
		})
	})
	return {
		http,
		prepare: (size: number) => {
			active?.end()
			active = undefined
			resumeId = undefined
			opened = 0
			openedAt = 0
			answers.length = 0
			fixture = makeTranscriptFixture(size)
			return fixture
		},
		connection: () => active,
		opened: () => opened,
		openedAt: () => openedAt,
		resumeId: () => resumeId,
		answers: () => answers,
	}
}

interface ProtocolResult {
	readonly result?: { readonly value?: unknown }
	readonly exceptionDetails?: { readonly text: string }
}

interface ProtocolReply {
	readonly id?: number
	readonly result?: ProtocolResult
	readonly error?: { readonly message: string }
}

const devtools = async (url: string) => {
	const socket = new WebSocket(url)
	await new Promise<void>((open, reject) => {
		socket.addEventListener("open", () => open(), { once: true })
		socket.addEventListener("error", () => reject(new Error("Could not open the browser")), {
			once: true,
		})
	})
	let nextId = 0
	const replies = new Map<
		number,
		ReturnType<typeof Promise.withResolvers<ProtocolResult | undefined>>
	>()
	socket.addEventListener("message", (event) => {
		const frame = JSON.parse(String(event.data)) as ProtocolReply
		if (frame.id === undefined) {
			return
		}
		const pending = replies.get(frame.id)
		replies.delete(frame.id)
		if (frame.error === undefined) {
			pending?.resolve(frame.result)
		} else {
			pending?.reject(new Error(frame.error.message))
		}
	})
	socket.addEventListener("close", () => {
		for (const pending of replies.values()) {
			pending.reject(new Error("Browser closed"))
		}
		replies.clear()
	})
	const send = (method: string, params: Record<string, string | number | boolean> = {}) => {
		const id = ++nextId
		const pending = Promise.withResolvers<ProtocolResult | undefined>()
		replies.set(id, pending)
		socket.send(JSON.stringify({ id, method, params }))
		return pending.promise
	}
	return {
		send,
		evaluate: async <A>(expression: string): Promise<A> => {
			const value = await send("Runtime.evaluate", {
				expression,
				awaitPromise: true,
				returnByValue: true,
			})
			if (value?.result === undefined || value.exceptionDetails !== undefined) {
				throw new Error(`Browser evaluation failed: ${JSON.stringify(value?.exceptionDetails)}`)
			}
			return value.result.value as A
		},
		close: () => socket.close(),
	}
}

const probe = `
(() => {
	const commits = []
	const hook = {
		supportsFiber: true,
		inject: () => 1,
		onCommitFiberRoot: () => commits.push(performance.now()),
	}
	globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook
	const list = () => document.querySelector("main ol")
	const waiting = () => Array.from(list()?.querySelectorAll("textarea") ?? [])
	const older = () => Array.from(document.querySelectorAll("main button"))
		.find((button) => button.textContent === "Load earlier messages")
	const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
	const matches = (rows, first, last) => {
		const current = list()
		return current?.childElementCount === rows &&
			(first === undefined || current.firstElementChild?.textContent.includes(first)) &&
			(last === undefined || current.lastElementChild?.textContent.includes(last))
	}
	globalThis.transcriptProbe = {
		list, waiting, older, frame, matches,
		arm(rows, first, last) {
			const started = performance.now()
			const baseline = commits.length
			this.result = new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					observer.disconnect()
					reject(new Error("Unexpected transcript viewport: " + list()?.childElementCount +
						" rows, expected " + rows + ", wanted last " + last +
						", actual last " + list()?.lastElementChild?.textContent))
				}, 10000)
				const observer = new MutationObserver(async () => {
					if (!matches(rows, first, last)) return
					observer.disconnect()
					clearTimeout(timer)
					const contentMs = performance.now() - started
					await frame()
					await frame()
					resolve({ contentMs, frameMs: performance.now() - started, commits: commits.length - baseline })
				})
				observer.observe(document.querySelector("main"), { subtree: true, childList: true, characterData: true })
			})
		}
	}
})()
`

interface BrowserSample {
	readonly contentMs: number
	readonly frameMs: number
	readonly commits: number
}

const json = (value: unknown) => JSON.stringify(value)

const profile = async (
	browser: Awaited<ReturnType<typeof devtools>>,
	server: ReturnType<typeof fixtureServer>,
	origin: string,
) => {
	const evaluate = browser.evaluate
	for (const size of transcriptSizes) {
		for (let run = 0; run <= 5; run++) {
			const fixture = server.prepare(size)
			const pageRows = fixture.pageSize * 0.8
			const baseRows = historyRowCount(size)
			await browser.send("Page.navigate", {
				url: `${origin}/sessions/${transcriptSession.id}?fixture=${size}-${run}`,
			})
			await until(() => server.connection(), "initial event stream")
			await until(
				() => evaluate<boolean>("globalThis.transcriptProbe?.waiting().length === 1"),
				"the automatic page load for a tool call",
			)
			const pendingOldPage = (target: number, first: string, last?: string) =>
				evaluate<BrowserSample>(
					`transcriptProbe.arm(${target}, ${json(first)}, ${json(last)}); transcriptProbe.older().click(); transcriptProbe.result`,
				)
			for (let loaded = 2 * fixture.pageSize; loaded < size; loaded += fixture.pageSize) {
				const after = loaded + fixture.pageSize
				await pendingOldPage(historyRowCount(after), rowLabel(fixture.newest - after + 1))
			}
			assert.equal(await evaluate<number>("transcriptProbe.list().childElementCount"), baseRows)
			assert.equal(
				await evaluate<boolean>(
					`transcriptProbe.waiting()[0].closest("li").textContent.includes(${json(waitingCallName)})`,
				),
				true,
			)
			await delay(300)

			let rows = baseRows
			let seq = fixture.newest
			let history = size
			const write = (events: Parameters<typeof streamEvents>[1]) => {
				const stream = server.connection()
				assert.ok(stream)
				streamEvents(stream, events)
			}
			const sample = async (
				target: number,
				first: string | undefined,
				last: string,
				deliver: () => void,
			) => {
				await evaluate(`transcriptProbe.arm(${target}, ${json(first)}, ${json(last)}); true`)
				deliver()
				return evaluate<BrowserSample>("transcriptProbe.result")
			}
			const record = (workload: string, measured: BrowserSample, extra = {}) => {
				assert.ok(measured.commits >= 1)
				if (run > 0) {
					process.stdout.write(
						`${json({ size, workload, run, history, rows, ...measured, ...extra })}\n`,
					)
				}
			}
			const append = appendBatch(seq)
			seq += append.length
			rows += append.length
			record("append", await sample(rows, undefined, rowLabel(seq), () => write(append)))
			const partial = `Partial fixture reply ${run}.`
			rows++
			record(
				"preview",
				await sample(rows, undefined, partial, () =>
					write(previewEvents(`evt_preview_${run}`, partial)),
				),
			)

			const overlap = append.slice(-2)
			const replay = appendBatch(seq)
			const disconnected = performance.now()
			const previousConnections = server.opened()
			server.connection()?.end()
			await until(
				() => server.opened() > previousConnections,
				"the browser to reconnect its event stream",
			)
			const reconnectMs = server.openedAt() - disconnected
			assert.equal(server.resumeId(), String(seq))
			seq += replay.length
			rows += replay.length - 1
			record(
				"reconnect",
				await sample(rows, undefined, rowLabel(seq), () => write([...overlap, ...replay])),
				{ reconnectMs, overlap: overlap.length },
			)
			history += fixture.pageSize
			rows += pageRows
			record(
				"prepend",
				await pendingOldPage(rows, rowLabel(fixture.newest - history + 1), rowLabel(seq)),
			)
			if (run !== 5) {
				continue
			}

			const finalReply = reply(seq + 1)
			const finalPreview = "Preview that the final reply replaces."
			const activeStream = server.connection()
			await sample(rows + 1, undefined, finalPreview, () =>
				write(previewEvents(finalReply.id, finalPreview)),
			)
			rows++
			await sample(rows, undefined, rowLabel(finalReply.seq), () => write([finalReply]))
			assert.equal(server.connection(), activeStream)
			assert.equal(
				await evaluate<boolean>(
					`transcriptProbe.list().textContent.includes(${json(finalPreview)})`,
				),
				false,
			)

			await evaluate(`
			const result = transcriptProbe.waiting()[0]
			result.focus()
			result.scrollIntoView({block: "center"})
			globalThis.anchoredTool = result
			globalThis.anchorTop = result.getBoundingClientRect().top
			true
		`)
			await pendingOldPage(
				rows + pageRows,
				rowLabel(fixture.newest - history - fixture.pageSize + 1),
			)
			const anchor = await evaluate<{
				readonly delta: number
				readonly retained: boolean
				readonly focused: boolean
			}>(`({
			delta: anchoredTool.getBoundingClientRect().top - anchorTop,
			retained: transcriptProbe.waiting()[0] === anchoredTool,
			focused: document.activeElement === anchoredTool,
		})`)
			assert.equal(anchor.retained, true)
			assert.equal(anchor.focused, true)
			assert.ok(Math.abs(anchor.delta) <= 1, `The scroll anchor moved ${anchor.delta} CSS pixels.`)
			const olderStart = fixture.newest - history - fixture.pageSize + 1
			assert.deepEqual(
				await evaluate<ReadonlyArray<string>>(`Array.from(
					transcriptProbe.list().children,
					(row) => row.textContent.match(${renderedRowMarker})?.[0],
				)`),
				[
					...historyRowMarkers(olderStart, fixture),
					...Array.from({ length: finalReply.seq - fixture.newest }, (_, index) =>
						rowLabel(fixture.newest + index + 1),
					),
				],
			)
			await evaluate(`
			Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(anchoredTool, "Fixture answer")
			anchoredTool.dispatchEvent(new Event("input", {bubbles: true}))
			true
		`)
			const press = async (key: string, code: number) => {
				await browser.send("Input.dispatchKeyEvent", {
					type: key === "Enter" ? "keyDown" : "rawKeyDown",
					...(key === "Enter" ? { text: "\r", unmodifiedText: "\r" } : {}),
					code: key,
					key,
					windowsVirtualKeyCode: code,
				})
				await browser.send("Input.dispatchKeyEvent", {
					type: "keyUp",
					key,
					windowsVirtualKeyCode: code,
				})
			}
			await press("Tab", 9)
			assert.equal(
				await evaluate<boolean>('document.activeElement?.matches("input[type=checkbox]")'),
				true,
			)
			await press("Tab", 9)
			assert.equal(
				await evaluate<boolean>("document.activeElement?.textContent === 'Send result'"),
				true,
			)
			await press("Enter", 13)
			await until(() => server.answers().length > 0, "the submitted tool result")
			const answer = {
				id: `evt_fixture_${finalReply.seq + 1}`,
				seq: finalReply.seq + 1,
				created_at: finalReply.created_at,
				processed_at: finalReply.processed_at,
				type: "user.custom_tool_result",
				custom_tool_use_id: waitingCallId,
				content: [{ type: "text", text: "Fixture answer" }],
			} satisfies Extract<JsonSessionEvent, { type: "user.custom_tool_result" }>
			write([answer])
			await until(
				() =>
					evaluate<boolean>(
						'transcriptProbe.list().textContent.includes("Your application answered")',
					),
				"the accepted answer to appear in the transcript",
			)
			await evaluate("transcriptProbe.frame().then(transcriptProbe.frame).then(() => true)")
			assert.deepEqual(server.answers(), [
				{
					events: [
						{
							type: "user.custom_tool_result",
							custom_tool_use_id: waitingCallId,
							content: [{ type: "text", text: "Fixture answer" }],
						},
					],
				},
			])
			process.stdout.write(
				`${json({ size, correctness: true, previewReplaced: true, anchor, answer: waitingCallId })}\n`,
			)
		}
	}
}

const livenessProbe = `
(() => {
	const NativeEventSource = globalThis.EventSource
	const events = []
	let current
	globalThis.EventSource = class extends NativeEventSource {
		constructor(...args) {
			super(...args)
			current = this
			for (const type of ["open", "error"]) {
				this.addEventListener(type, () => events.push({ type, state: this.readyState, at: performance.now() }))
			}
		}
	}
	globalThis.observeStreamLiveness = () => ({
		state: current?.readyState,
		events,
		banner: document.body.textContent.includes("Live updates were interrupted."),
	})
})()
`

interface StreamObservation {
	readonly state: number
	readonly events: ReadonlyArray<{
		readonly type: string
		readonly state: number
		readonly at: number
	}>
	readonly banner: boolean
}

const profileLiveness = async (
	browser: Awaited<ReturnType<typeof devtools>>,
	server: ReturnType<typeof fixtureServer>,
	origin: string,
) => {
	const observe = () => browser.evaluate<StreamObservation>("globalThis.observeStreamLiveness()")
	const observeMs = 6500
	for (const kind of ["silent", "keepalive", "abrupt-close"] as const) {
		const fixture = server.prepare(100)
		await browser.send("Page.navigate", {
			url: `${origin}/sessions/${transcriptSession.id}?liveness=${kind}`,
		})
		const stream = await until(() => server.connection(), "the liveness event stream")
		await until(
			async () => (await observe()).events[0]?.type === "open",
			"the browser EventSource to open",
		)
		const event = reply(fixture.newest + 1)
		streamEvents(stream, [event])
		await until(
			() =>
				browser.evaluate<boolean>(
					`transcriptProbe.list()?.lastElementChild?.textContent.includes(${json(rowLabel(event.seq))})`,
				),
			"the new sequence to render",
		)
		const start = performance.now()
		let heartbeats = 0
		const keepalive =
			kind === "keepalive"
				? setInterval(() => {
						stream.write(": keepalive\n\n")
						heartbeats += 1
					}, 300)
				: undefined
		try {
			if (kind === "abrupt-close") {
				stream.socket?.destroy()
				await until(() => server.opened() === 2, "automatic EventSource resume")
				assert.equal(server.resumeId(), String(event.seq))
				await until(
					async () =>
						(await observe()).events.some(({ type }) => type === "open") &&
						(await observe()).events.some(({ type }) => type === "error") &&
						(await observe()).state === 1,
					"the reopened EventSource",
				)
			} else {
				await delay(observeMs)
				assert.equal(server.opened(), 1)
				if (kind === "keepalive") {
					assert.ok(heartbeats > 1)
				}
			}
			const observation = await observe()
			assert.equal(observation.state, 1)
			assert.equal(observation.banner, false)
			assert.deepEqual(
				observation.events.map(({ type }) => type),
				kind === "abrupt-close" ? ["open", "error", "open"] : ["open"],
			)
			process.stdout.write(
				`${json({ kind, elapsedMs: Math.round(performance.now() - start), heartbeats, sequence: event.seq, resumeId: server.resumeId(), ...observation })}\n`,
			)
		} finally {
			clearInterval(keepalive)
		}
	}
}

assert.ok(chrome, "Set CHROME_PATH to a Chrome or Chromium executable.")
const server = fixtureServer()
await new Promise<void>((done) => {
	server.http.listen(0, "127.0.0.1", done)
})
const address = server.http.address()
assert.ok(address !== null && typeof address === "object")
const directory = await mkdtemp(join(tmpdir(), "checkfu-transcript-chrome-"))
const child = spawn(
	chrome,
	[
		"--headless",
		"--disable-background-timer-throttling",
		"--disable-background-networking",
		"--window-size=1280,900",
		"--remote-debugging-port=0",
		`--user-data-dir=${directory}`,
		"about:blank",
	],
	{ stdio: "ignore" },
)
let browser: Awaited<ReturnType<typeof devtools>> | undefined
try {
	const port = await until(async () => {
		const file = await readFile(join(directory, "DevToolsActivePort"), "utf8").catch(
			() => undefined,
		)
		return file?.split("\n")[0]
	}, "the browser debugger")
	const debug = `http://127.0.0.1:${port}`
	const targets = (await (await fetch(`${debug}/json/list`)).json()) as ReadonlyArray<{
		readonly type: string
		readonly webSocketDebuggerUrl: string
	}>
	const page = targets.find((entry) => entry.type === "page")
	assert.ok(page)
	browser = await devtools(page.webSocketDebuggerUrl)
	const version = (await (await fetch(`${debug}/json/version`)).json()) as {
		readonly Browser: string
	}
	process.stdout.write(`${json({ browser: version.Browser, viewport: "1280x900", retryMs })}\n`)
	await browser.send("Page.enable")
	await browser.send("Page.addScriptToEvaluateOnNewDocument", {
		source: probe,
		runImmediately: true,
	})
	assert.equal(await browser.evaluate("typeof globalThis.transcriptProbe"), "object")
	const origin = `http://127.0.0.1:${address.port}`
	if (process.argv.includes("--liveness")) {
		await browser.send("Page.addScriptToEvaluateOnNewDocument", { source: livenessProbe })
		await profileLiveness(browser, server, origin)
	} else {
		await profile(browser, server, origin)
	}
} finally {
	browser?.close()
	const exited = new Promise<void>((done) => {
		child.once("exit", () => done())
	})
	child.kill("SIGTERM")
	await Promise.race([exited, delay(2000, undefined, { ref: false })])
	server.http.close()
	server.http.closeAllConnections()
	await rm(directory, { recursive: true, force: true })
}
