import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { runInNewContext } from "node:vm"
import { describe, expect, it } from "@effect/vitest"
import * as Digest from "effect/crypto/Digest"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import { buildArtifactVersion, readDeclaration } from "../src/Artifacts/ArtifactFiles.ts"

const ROOT = fileURLToPath(new URL("../../../packages/domain/src/Artifact/types/", import.meta.url))
const TYPES = ["dashboard", "document", "slides"] as const

const fileOf = (type: string, name: string) => readFileSync(`${ROOT}${type}/${name}`, "utf8")

const scriptsOf = (html: string): ReadonlyArray<string> => {
	const scripts: Array<string> = []
	let from = 0
	for (;;) {
		const open = html.indexOf("<script", from)
		if (open === -1) {
			return scripts
		}
		const start = html.indexOf(">", open) + 1
		const end = html.indexOf("</script>", start)
		const body = html.slice(start, end)
		if (body.trim() !== "") {
			scripts.push(body)
		}
		from = end
	}
}

interface Element {
	innerHTML: string
	textContent: string
	readonly listeners: Array<() => void>
}

interface Listed {
	readonly data: ReadonlyArray<{ readonly id: string; readonly data: unknown }>
	readonly next_page: string | null
}

interface DeckKey {
	readonly key: string
	readonly target?: { readonly closest: (selector: string) => object | null }
	readonly preventDefault: () => void
}

interface PageGlobals {
	readonly location?: { readonly hash: string }
	readonly fetch?: (
		path: string,
	) => Promise<{ readonly ok: boolean; readonly text: () => Promise<string> }>
	readonly artifactData?: {
		readonly collection: (name: string) => {
			readonly list: (options: {
				readonly limit: number
				readonly page?: string
			}) => Promise<Listed | undefined>
		}
	}
}

interface PageContext extends PageGlobals {
	globalThis?: PageContext
	renderMarkdown?: (text: string) => string
	splitSlides?: (text: string) => ReadonlyArray<string>
	numberCards?: (documents: Listed["data"]) => string
	readonly document?: {
		readonly getElementById: (id: string) => Pick<Element, "innerHTML" | "textContent">
		readonly addEventListener: (type: string, listener: (event: DeckKey) => void) => void
		title: string
	}
	readonly history?: { readonly replaceState: () => void }
	readonly setInterval?: () => number
}

const scope = (members: PageContext): PageContext => {
	const context: PageContext = { ...members }
	context.globalThis = context
	return context
}

const page = (type: string, extra: PageGlobals) => {
	const elements = new Map<string, Element>()
	const keys: Array<(event: DeckKey) => void> = []
	const element = (id: string) => {
		const made = elements.get(id) ?? { innerHTML: "", textContent: "", listeners: [] }
		elements.set(id, made)
		return {
			get innerHTML() {
				return made.innerHTML
			},
			set innerHTML(value: string) {
				made.innerHTML = value
			},
			get textContent() {
				return made.textContent
			},
			set textContent(value: string) {
				made.textContent = value
			},
			querySelector: () => null,
			addEventListener: (_: string, listener: () => void) => {
				made.listeners.push(listener)
			},
		}
	}
	const context = scope({
		document: {
			getElementById: element,
			addEventListener: (_type, listener) => {
				keys.push(listener)
			},
			title: "",
		},
		location: { hash: "" },
		history: { replaceState: () => undefined },
		setInterval: () => 0,
		...extra,
	})
	for (const script of scriptsOf(fileOf(type, "index.html"))) {
		runInNewContext(script, context)
	}
	return { context, elements, keys }
}

const settled = () =>
	Effect.promise(
		() =>
			new Promise<void>((resolve) => {
				setTimeout(resolve, 10)
			}),
	)

const content = (text: string) => ({
	fetch: (path: string) =>
		Promise.resolve({ ok: path === "content.md", text: () => Promise.resolve(text) }),
})

describe("The example artifact types", () => {
	it.effect("are each a valid artifact with a page, a declaration and instructions", () =>
		Effect.gen(function* () {
			const digest = yield* Digest.Digest
			expect(
				readdirSync(ROOT)
					.filter((name) => !name.includes("."))
					.toSorted(),
			).toEqual([...TYPES])
			const declared: Record<string, string> = {}
			for (const type of TYPES) {
				const names = readdirSync(`${ROOT}${type}`).toSorted()
				expect([type, names]).toEqual([type, ["README.md", "artifact.json", "index.html"]])
				const built = yield* buildArtifactVersion(
					digest,
					names.map((path) => ({ path, content: fileOf(type, path) })),
				)
				expect(built.file_count).toBe(3)
				const declaration = readDeclaration(new TextEncoder().encode(fileOf(type, "artifact.json")))
				declared[type] = Result.isSuccess(declaration) ? declaration.success : "invalid"
			}
			expect(declared).toEqual({
				dashboard: '{"database":{"collections":{"numbers":{"visitors":"read"}}}}',
				document: "",
				slides: "",
			})
		}).pipe(Effect.provide(Digest.layerWebCrypto)),
	)

	it("render the same Markdown, and show markup in the content as text", () => {
		const [documentRenderer] = scriptsOf(fileOf("document", "index.html"))
		const [slidesRenderer] = scriptsOf(fileOf("slides", "index.html"))
		expect(documentRenderer).toBe(slidesRenderer)
		const context = scope({})
		runInNewContext(documentRenderer ?? "", context)
		const render = context.renderMarkdown ?? (() => "the renderer is missing")
		expect(
			render(
				[
					"# Title",
					"",
					"A **bold** and *soft* line",
					"that continues, with `code` and a [link](https://example.com/a?b=1).",
					"",
					"- one",
					"- two",
					"",
					"1. first",
					"2. second",
					"> quoted",
					"***",
					"```",
					"<b>kept as text</b>",
					"# not a heading",
					"```",
					"![chart](images/chart.png)",
				].join("\n"),
			),
		).toBe(
			[
				"<h1>Title</h1>",
				'<p>A <strong>bold</strong> and <em>soft</em> line that continues, with <code>code</code> and a <a href="https://example.com/a?b=1">link</a>.</p>',
				"<ul><li>one</li><li>two</li></ul>",
				"<ol><li>first</li><li>second</li></ol>",
				"<blockquote>quoted</blockquote>",
				"<hr>",
				"<pre><code>&lt;b&gt;kept as text&lt;/b&gt;\n# not a heading</code></pre>",
				'<p><img alt="chart" src="images/chart.png"></p>',
			].join("\n"),
		)
		expect(render("[report](files/report*copy*.png) and `a*b*c`")).toBe(
			'<p><a href="files/report*copy*.png">report</a> and <code>a*b*c</code></p>',
		)
		expect(render("**[Read the report](report.md)** or *Run `checkfu` first*")).toBe(
			'<p><strong><a href="report.md">Read the report</a></strong> or <em>Run <code>checkfu</code> first</em></p>',
		)
		expect(render('<script>alert(1)</script> [x](javascript:alert(1)) [y](" onclick="z)')).toBe(
			'<p>&lt;script&gt;alert(1)&lt;/script&gt; <a href="#">x</a>) [y](&quot; onclick=&quot;z)</p>',
		)
	})

	it.effect("show a document's content.md, or say when it is missing", () =>
		Effect.gen(function* () {
			const shown = page("document", content("# Q3\n\nRevenue grew."))
			yield* settled()
			expect(shown.elements.get("content")?.innerHTML).toBe("<h1>Q3</h1>\n<p>Revenue grew.</p>")
			const missing = page("document", {
				fetch: () => Promise.resolve({ ok: false, text: () => Promise.resolve("") }),
			})
			yield* settled()
			expect(missing.elements.get("content")?.textContent).toBe("content.md is missing")
		}),
	)

	it.effect("split a deck at --- lines outside code, and step through it", () =>
		Effect.gen(function* () {
			const deck = page(
				"slides",
				content("# One\n---\n# Two\n```\n---\n```\n\n---\n\n---\n# Three"),
			)
			expect(deck.context.splitSlides?.("a\n---\nb\n```\n---\n```\n---\n\n---\nc")).toEqual([
				"a",
				"b\n```\n---\n```",
				"c",
			])
			yield* settled()
			const slide = () => deck.elements.get("content")?.innerHTML
			const position = () => deck.elements.get("position")?.textContent
			expect([slide(), position()]).toEqual(["<h1>One</h1>", "1 / 3"])
			const press = (id: string) => {
				for (const listener of deck.elements.get(id)?.listeners ?? []) {
					listener()
				}
			}
			press("next")
			expect([slide(), position()]).toEqual(["<h1>Two</h1>\n<pre><code>---</code></pre>", "2 / 3"])
			press("next")
			press("next")
			expect([slide(), position()]).toEqual(["<h1>Three</h1>", "3 / 3"])
			press("previous")
			press("previous")
			press("previous")
			expect(position()).toBe("1 / 3")
		}),
	)

	it.effect("normalizes a fractional slide and leaves Space on a button to its native click", () =>
		Effect.gen(function* () {
			const deck = page("slides", {
				...content("# One\n---\n# Two\n---\n# Three"),
				location: { hash: "#1.5" },
			})
			yield* settled()
			const position = () => deck.elements.get("position")?.textContent
			expect(position()).toBe("1 / 3")
			let prevented = 0
			const preventDefault = () => {
				prevented += 1
			}
			for (const listener of deck.keys) {
				listener({ key: " ", target: { closest: () => ({}) }, preventDefault })
			}
			expect(position()).toBe("1 / 3")
			expect(prevented).toBe(0)
			for (const listener of deck.elements.get("next")?.listeners ?? []) {
				listener()
			}
			expect(position()).toBe("2 / 3")
			for (const listener of deck.keys) {
				listener({ key: " ", preventDefault })
			}
			expect(position()).toBe("3 / 3")
		}),
	)

	it.effect(
		"show a dashboard's numbers from its collection, across pages, and explain a refusal",
		() =>
			Effect.gen(function* () {
				const pages = new Map<string, Listed>([
					[
						"first",
						{
							data: [
								{ id: "title", data: "Q3 <numbers>" },
								{
									id: "revenue",
									data: { label: "Revenue", value: 1200, unit: "USD", note: "up 18%" },
								},
							],
							next_page: "2",
						},
					],
					["2", { data: [{ id: "users", data: 42 }], next_page: null }],
				])
				const asked: Array<unknown> = []
				const board = page("dashboard", {
					artifactData: {
						collection: (name: string) => ({
							list: (options: { page?: string }) => {
								asked.push([name, options.page ?? null])
								return Promise.resolve(pages.get(options.page ?? "first"))
							},
						}),
					},
				})
				yield* settled()
				expect(asked).toEqual([
					["numbers", null],
					["numbers", "2"],
				])
				expect(board.elements.get("title")?.textContent).toBe("Q3 <numbers>")
				expect(board.elements.get("numbers")?.innerHTML).toBe(
					'<article><div class="label">Revenue</div><div class="value">1200 USD</div><div class="note">up 18%</div></article>' +
						'<article><div class="label">users</div><div class="value">42</div></article>',
				)
				expect(
					board.context.numberCards?.([{ id: "x", data: { label: "<b>", value: "<i>" } }]),
				).toBe(
					'<article><div class="label">&lt;b&gt;</div><div class="value">&lt;i&gt;</div></article>',
				)

				const refused = page("dashboard", {
					artifactData: {
						collection: () => ({
							list: () => Promise.reject(Object.assign(new Error("refused"), { status: 403 })),
						}),
					},
				})
				yield* settled()
				expect(refused.elements.get("status")?.textContent).toContain("Share it with read access")
			}),
	)
	it.effect("stops loading dashboard pages at its displayed document limit", () =>
		Effect.gen(function* () {
			const limits: Array<number> = []
			const dashboard = page("dashboard", {
				artifactData: {
					collection: () => ({
						list: ({ limit, page }) => {
							limits.push(limit)
							const offset = Number(page ?? 0)
							const length = Math.min(limit, 8)
							return Promise.resolve({
								data: Array.from({ length }, (_, index) => ({
									id: "metric-" + (offset + index),
									data: index,
								})),
								next_page: String(offset + length),
							})
						},
					}),
				},
			})
			yield* settled()
			expect(limits).toHaveLength(13)
			expect(limits.at(-1)).toBe(4)
			expect(dashboard.elements.get("status")?.textContent).toContain(
				"Showing the first 100 documents",
			)
			expect(dashboard.elements.get("numbers")?.innerHTML).toContain("metric-99")
			expect(dashboard.elements.get("numbers")?.innerHTML).not.toContain("metric-100")
		}),
	)
})
