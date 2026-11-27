import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, resolve, sep } from "node:path"
import { brotliCompressSync } from "node:zlib"
import { build } from "vite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const COLD_ENTRY_JS = 150_000
const ROUTE_JS = 50_000
const FIRST_VIEW_CSS = 20_000

interface Chunk {
	readonly file: string
	readonly isEntry?: boolean
	readonly imports?: ReadonlyArray<string>
	readonly css?: ReadonlyArray<string>
}

const root = resolve(import.meta.dirname, "..")
const outDir = mkdtempSync(join(tmpdir(), "checkfu-app-build-"))
let manifest: Record<string, Chunk> = {}

beforeAll(async () => {
	await build({
		root,
		mode: "production",
		logLevel: "silent",
		define: { "process.env.NODE_ENV": JSON.stringify("production") },
		build: { outDir, manifest: true, emptyOutDir: true },
	})
	manifest = JSON.parse(
		readFileSync(join(outDir, ".vite", "manifest.json"), "utf8"),
	) as typeof manifest
}, 120_000)

afterAll(() => rmSync(outDir, { recursive: true, force: true }))

const closure = (keys: ReadonlyArray<string>): ReadonlySet<string> => {
	const seen = new Set<string>()
	const visit = (key: string) => {
		if (seen.has(key)) {
			return
		}
		seen.add(key)
		for (const next of manifest[key]?.imports ?? []) {
			visit(next)
		}
	}
	keys.forEach(visit)
	return seen
}

const compressed = new Map<string, number>()
const brotliOf = (file: string): number => {
	const known = compressed.get(file)
	if (known !== undefined) {
		return known
	}
	const size = brotliCompressSync(readFileSync(join(outDir, file))).length
	compressed.set(file, size)
	return size
}
const brotli = (files: Iterable<string>): number =>
	[...new Set(files)].reduce((total, file) => total + brotliOf(file), 0)

const jsOf = (keys: Iterable<string>) => [...keys].flatMap((key) => manifest[key]?.file ?? [])
const cssOf = (keys: Iterable<string>) => [...keys].flatMap((key) => manifest[key]?.css ?? [])
const chunksOf = (route: string) =>
	Object.keys(manifest).filter((key) => key === route || key.startsWith(`${route}?`))

const NON_SCREEN_ROUTES = new Set([
	"src/routes/__root.tsx", // Root outlet.
	"src/routes/_app.tsx", // Signed-in layout, measured with each child screen.
	"src/routes/_app/index.tsx", // Redirects to sessions.
])

const isScreenRoute = (path: string): boolean =>
	path.startsWith("src/routes/") &&
	/\.[jt]sx?$/u.test(path) &&
	!path.split("/").some((segment) => segment.startsWith(".") || segment.startsWith("-")) &&
	!NON_SCREEN_ROUTES.has(path)

const ROUTES = readdirSync(join(root, "src/routes"), { recursive: true, withFileTypes: true })
	.filter((entry) => entry.isFile())
	.map((entry) => relative(root, join(entry.parentPath, entry.name)).replaceAll(sep, "/"))
	.filter(isScreenRoute)
	.sort()

describe("first view", () => {
	it("measures every screen in the production manifest", () => {
		const compiled = Object.keys(manifest)
			.map((key) => key.split("?", 1)[0] ?? key)
			.filter(isScreenRoute)
		expect(ROUTES).toEqual([...new Set(compiled)].sort())
	})

	it.each(ROUTES)("keeps a cold load of %s within budget", (route) => {
		const entry = closure(Object.keys(manifest).filter((key) => manifest[key]?.isEntry))
		const own = chunksOf(route)
		expect(own.length, `No manifest chunks for ${route}`).toBeGreaterThan(0)
		const layouts = route.startsWith("src/routes/_app/") ? chunksOf("src/routes/_app.tsx") : []
		const routeChunks = [...own, ...layouts]
		const cold = closure([...entry, ...routeChunks])
		const specific = [...cold].filter((key) => !entry.has(key))
		expect({
			route,
			coldJs: brotli(jsOf(cold)) <= COLD_ENTRY_JS,
			routeJs: brotli(jsOf(specific)) <= ROUTE_JS,
			css: brotli(cssOf(cold)) <= FIRST_VIEW_CSS,
		}).toEqual({ route, coldJs: true, routeJs: true, css: true })
	})
})
