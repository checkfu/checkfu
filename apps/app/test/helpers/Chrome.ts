import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

export const until = async <A>(
	attempt: () => A | Promise<A>,
	label: string,
): Promise<NonNullable<A>> => {
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

interface ProtocolResult {
	readonly result?: { readonly value?: unknown }
	readonly exceptionDetails?: { readonly text: string }
}

interface ProtocolReply {
	readonly id?: number
	readonly result?: ProtocolResult
	readonly error?: { readonly message: string }
}

export const openDevtools = async (url: string) => {
	const socket = new WebSocket(url)
	try {
		await new Promise<void>((open, reject) => {
			const timeout = setTimeout(() => reject(new Error("Browser debugger did not connect.")), 5000)
			socket.addEventListener(
				"open",
				() => {
					clearTimeout(timeout)
					open()
				},
				{ once: true },
			)
			socket.addEventListener(
				"error",
				() => {
					clearTimeout(timeout)
					reject(new Error("Could not open the browser"))
				},
				{ once: true },
			)
		})
	} catch (error) {
		socket.close()
		throw error
	}
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
	const send = async (method: string, params: Record<string, string | number | boolean> = {}) => {
		const id = ++nextId
		const pending = Promise.withResolvers<ProtocolResult | undefined>()
		const timeout = setTimeout(
			() => pending.reject(new Error("Browser did not answer " + method)),
			5000,
		)
		replies.set(id, pending)
		try {
			socket.send(JSON.stringify({ id, method, params }))
			return await pending.promise
		} finally {
			clearTimeout(timeout)
			replies.delete(id)
		}
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

export const withChrome = async <A>(
	executable: string,
	run: (browser: Awaited<ReturnType<typeof openDevtools>>, version: string) => Promise<A>,
): Promise<A> => {
	const directory = await mkdtemp(join(tmpdir(), "checkfu-chrome-"))
	const child = spawn(
		executable,
		[
			"--headless",
			"--disable-background-timer-throttling",
			"--disable-background-networking",
			"--window-size=1280,900",
			"--remote-debugging-port=0",
			"--user-data-dir=" + directory,
			...(process.env["CI"] === "true" && process.platform === "linux" ? ["--no-sandbox"] : []),
			"about:blank",
		],
		{ stdio: "ignore" },
	)
	let failed: Error | undefined
	const exited = new Promise<void>((resolve) => {
		child.once("error", (error) => {
			failed = error
			resolve()
		})
		child.once("exit", () => resolve())
	})
	let browser: Awaited<ReturnType<typeof openDevtools>> | undefined
	try {
		const port = await until(async () => {
			if (failed !== undefined) {
				throw failed
			}
			if (child.exitCode !== null) {
				throw new Error("Chrome exited before opening its debugger.")
			}
			const file = await readFile(join(directory, "DevToolsActivePort"), "utf8").catch(
				() => undefined,
			)
			return file?.split("\n")[0]
		}, "the browser debugger")
		const debug = "http://127.0.0.1:" + port
		const inspect = (path: string) => fetch(debug + path, { signal: AbortSignal.timeout(5000) })
		const targets = (await (await inspect("/json/list")).json()) as ReadonlyArray<{
			readonly type: string
			readonly webSocketDebuggerUrl: string
		}>
		const page = targets.find((entry) => entry.type === "page")
		assert.ok(page)
		browser = await openDevtools(page.webSocketDebuggerUrl)
		const version = (await (await inspect("/json/version")).json()) as { readonly Browser: string }
		await browser.send("Page.enable")
		return await run(browser, version.Browser)
	} finally {
		browser?.close()
		child.kill("SIGTERM")
		await Promise.race([exited, delay(2000, undefined, { ref: false })])
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL")
			await Promise.race([exited, delay(2000, undefined, { ref: false })])
		}
		await rm(directory, { recursive: true, force: true })
	}
}
