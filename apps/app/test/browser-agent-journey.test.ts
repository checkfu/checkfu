import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import { extname, resolve } from "node:path"
import { Checkfu } from "@checkfu/sdk"
import * as Effect from "effect/Effect"
import { expect, it } from "vitest"
import { IsSupportedAgentModel } from "../../api/src/Http/AgentsHandlers.ts"
import { makeTestServer, TEST_API_KEY } from "../../mcp/test/helpers/McpHarness.ts"
import dashboard from "../worker.ts"
import { until, withChrome } from "./helpers/Chrome.ts"

const dist = resolve(import.meta.dirname, "../dist")
const assetTypes = new Map([
	[".html", "text/html"],
	[".js", "text/javascript"],
	[".css", "text/css"],
	[".svg", "image/svg+xml"],
	[".woff2", "font/woff2"],
])

const assets: typeof globalThis.fetch = async (request) => {
	const { pathname } = new URL(
		typeof request === "object" && "url" in request ? request.url : String(request),
	)
	const path = /^\/assets\/[\w.-]+$/u.test(pathname) ? pathname.slice(1) : "index.html"
	const content = await readFile(resolve(dist, path))
	return new Response(new Uint8Array(content), {
		headers: { "content-type": assetTypes.get(extname(path)) ?? "application/octet-stream" },
	})
}

const withDashboard = async <A>(
	apiFetch: typeof globalThis.fetch,
	run: (origin: string) => Promise<A>,
): Promise<A> => {
	let origin = ""
	const fixture = createServer((incoming, outgoing) => {
		void (async () => {
			const method = incoming.method ?? "GET"
			const headers = new Headers()
			for (const [key, value] of incoming.headersDistinct
				? Object.entries(incoming.headersDistinct)
				: []) {
				for (const field of value ?? []) {
					headers.append(key, field)
				}
			}
			const chunks: Array<Buffer> = []
			for await (const part of incoming) {
				chunks.push(Buffer.from(part))
			}
			const request = new Request(new URL(incoming.url ?? "/", origin), {
				method,
				headers,
				...(chunks.length === 0 ? {} : { body: new Uint8Array(Buffer.concat(chunks)) }),
			})
			const response = await dashboard.fetch(request, {
				CHECKFU_API_KEY: TEST_API_KEY,
				API: { fetch: apiFetch },
				ASSETS: { fetch: assets },
			})
			outgoing.writeHead(response.status, Object.fromEntries(response.headers))
			outgoing.end(Buffer.from(await response.arrayBuffer()))
		})().catch(() => {
			outgoing.writeHead(500).end("Dashboard test server failed.")
		})
	})
	try {
		await new Promise<void>((listen, reject) => {
			fixture.once("error", reject)
			fixture.listen(0, "127.0.0.1", listen)
		})
		const address = fixture.address()
		assert.ok(address !== null && typeof address === "object")
		origin = "http://app-" + address.port + ".localhost:" + address.port
		return await run(origin)
	} finally {
		fixture.close()
		fixture.closeAllConnections()
	}
}

const chrome = process.env["CHROME_PATH"]
const required = process.env["CHECKFU_REQUIRE_BROWSER"] === "1"
const model = "browser-journey-model"

it.skipIf(!required && !chrome)(
	"signs in in Chrome, resolves an agent edit conflict and revisits the saved version",
	{ timeout: 75_000, tags: ["acceptance", "browser-agent-conflict"] },
	async () => {
		assert.ok(chrome, "Set CHROME_PATH to the Chrome executable for this verification.")
		await Effect.runPromise(
			Effect.gen(function* () {
				const { apiFetch } = yield* makeTestServer.pipe(
					Effect.provideService(IsSupportedAgentModel, (id) => id === model),
				)
				yield* Effect.promise(async () => {
					const other = new Checkfu({
						baseUrl: "https://api.test",
						apiKey: TEST_API_KEY,
						fetch: apiFetch,
					})
					try {
						const name = "Browser report agent"
						const draft = "My unsaved browser description"
						const newerSystem = "Keep the teammate's latest instructions."
						const agent = await other.waitForPending(await other.agents.create({ name, model }))
						await withDashboard(apiFetch, (origin) =>
							withChrome(chrome, async (browser, version) => {
								const { evaluate, send } = browser
								const routes: Array<string> = []
								const view = async (path: string, text: string) => {
									await until(
										() =>
											evaluate<boolean>(
												"location.pathname === " +
													JSON.stringify(path) +
													" && document.body.innerText.includes(" +
													JSON.stringify(text) +
													")",
											),
										path + " showing " + text,
									)
									routes.push(path)
								}
								const click = (tag: "a" | "button", label: string) =>
									until(
										() =>
											evaluate<boolean>(
												"Array.from(document.querySelectorAll(" +
													JSON.stringify(tag) +
													")).some(element => { if (element.textContent.trim() !== " +
													JSON.stringify(label) +
													" || element.disabled) return false; element.click(); return true })",
											),
										label,
									)
								const fill = async (selector: string, value: string) => {
									await until(
										() =>
											evaluate<boolean>(
												"(() => { const field = document.querySelector(" +
													JSON.stringify(selector) +
													"); if (!field) return false; field.focus(); return true })()",
											),
										selector,
									)
									await send("Input.insertText", { text: value })
								}
								await send("Page.navigate", { url: origin + "/agents" })
								await view("/sign-in", "Sign in")
								await fill('input[name="key"]', TEST_API_KEY)
								await click("button", "Sign in")
								await view("/agents", name)
								await click("a", name)
								const detail = "/agents/" + agent.id
								await view(detail, "v1")
								await click("button", "Edit")
								await until(
									() =>
										evaluate<boolean>(
											"Array.from(document.querySelectorAll('label')).some(label => { if (label.textContent !== 'Description' || !label.control) return false; label.control.focus(); return true })",
										),
									"description editor",
								)
								await send("Input.insertText", { text: draft })
								await other.waitForPending(
									await other.agents.update(agent.id, { version: 1, system: newerSystem }),
								)
								await click("button", "Save new version")
								await view(detail, "Apply my edits to v2")
								expect(
									await evaluate<string>(
										"document.activeElement?.value ?? Array.from(document.querySelectorAll('label')).find(label => label.textContent === 'Description')?.control?.value",
									),
								).toBe(draft)
								expect((await other.agents.retrieve(agent.id)).version).toBe(2)
								await click("button", "Apply my edits to v2")
								await click("button", "Save new version")
								await view(detail, "v3")
								expect(await other.agents.retrieve(agent.id)).toMatchObject({
									version: 3,
									description: draft,
									system: newerSystem,
								})
								await evaluate<void>("history.back()")
								await view("/agents", name)
								await evaluate<void>("history.forward()")
								await view(detail, "v3")
								expect(
									await evaluate<boolean>(
										"document.body.innerText.includes(" + JSON.stringify(draft) + ")",
									),
								).toBe(true)
								process.stdout.write(
									JSON.stringify({ browser: version, routes, persistedVersion: 3 }) + "\n",
								)
							}),
						)
					} finally {
						await other.close()
					}
				})
			}).pipe(Effect.scoped),
		)
	},
)
