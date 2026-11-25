import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
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

const ROUTES = [
	"src/routes/sign-in.tsx",
	"src/routes/_app/sessions/index.tsx",
	"src/routes/_app/sessions/new.tsx",
	"src/routes/_app/sessions/$sessionId.tsx",
	"src/routes/_app/agents/index.tsx",
	"src/routes/_app/agents/new.tsx",
	"src/routes/_app/agents/$agentId.tsx",
	"src/routes/_app/environments/index.tsx",
	"src/routes/_app/environments/new.tsx",
	"src/routes/_app/environments/$environmentId.tsx",
	"src/routes/_app/automations/index.tsx",
	"src/routes/_app/automations/new.tsx",
	"src/routes/_app/automations/$automationId.tsx",
	"src/routes/_app/artifacts/index.tsx",
	"src/routes/_app/artifacts/$artifactId.tsx",
]

describe("first view", () => {
	it.each(ROUTES)("keeps a cold load of %s within budget", (route) => {
		const entry = closure(Object.keys(manifest).filter((key) => manifest[key]?.isEntry))
		const own = chunksOf(route)
		expect(own.length).toBeGreaterThan(0)
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
