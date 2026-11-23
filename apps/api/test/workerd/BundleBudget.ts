import { execFile } from "node:child_process"
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

const run = promisify(execFile)

const STATIC_IMPORT = /(?:\bfrom|\bimport)\s*["'](\.{1,2}\/[^"']+)["']/g
const PLATFORM_IMPORT = /import\s*\{([^}]*)\}\s*from\s*["']cloudflare:[^"']+["']/g

export interface BundleMeasurement {
	readonly eagerBytes: number
	readonly eagerFiles: ReadonlyArray<string>
	readonly totalBytes: number
	readonly startupCpuMs: number
}

const eagerClosure = (entry: string): ReadonlyArray<string> => {
	const seen = new Set<string>()
	const pending = [entry]
	while (pending.length > 0) {
		const file = pending.pop()
		if (file === undefined || seen.has(file)) {
			continue
		}
		seen.add(file)
		for (const match of readFileSync(file, "utf8").matchAll(STATIC_IMPORT)) {
			if (match[1] !== undefined) {
				pending.push(resolve(dirname(file), match[1]))
			}
		}
	}
	return [...seen]
}

const platformExports = (files: ReadonlyArray<string>): ReadonlyArray<string> => {
	const names = new Set<string>()
	for (const file of files) {
		for (const match of readFileSync(file, "utf8").matchAll(PLATFORM_IMPORT)) {
			for (const specifier of (match[1] ?? "").split(",")) {
				const name = specifier.trim().split(/\s+as\s+/)[0]
				if (name !== undefined && name.length > 0 && name !== "default") {
					names.add(name)
				}
			}
		}
	}
	return [...names]
}

const LOADER = `
const names = JSON.parse(process.env.CHECKFU_PLATFORM_EXPORTS ?? "[]")
export const resolve = (specifier, context, next) =>
	specifier.startsWith("cloudflare:")
		? { url: "checkfu-platform:" + specifier, shortCircuit: true }
		: next(specifier, context)
export const load = (url, context, next) =>
	url.startsWith("checkfu-platform:")
		? {
				format: "module",
				shortCircuit: true,
				source:
					names.map((name) => "export class " + name + " { constructor(ctx, env) { this.ctx = ctx; this.env = env } }").join("\\n") +
					"\\nexport default {}",
			}
		: next(url, context)
`

const REGISTER = `
import { register } from "node:module"
register("./loader.mjs", import.meta.url)
`

const TIME = `
const before = process.cpuUsage()
await import(process.argv[2])
const used = process.cpuUsage(before)
process.stdout.write(String((used.user + used.system) / 1000))
`

/**
 * CPU time to evaluate the entry module's global scope, the work Cloudflare
 * bounds at one second (error 10021). Measured under Node with the platform
 * modules stubbed, so it tracks the trend, not Cloudflare's own number.
 */
const startupCpuMs = async (entry: string, exports: ReadonlyArray<string>): Promise<number> => {
	const dir = mkdtempSync(join(tmpdir(), "checkfu-startup-"))
	try {
		writeFileSync(join(dir, "loader.mjs"), LOADER)
		writeFileSync(join(dir, "register.mjs"), REGISTER)
		writeFileSync(join(dir, "time.mjs"), TIME)
		const samples: Array<number> = []
		for (let sample = 0; sample < 3; sample++) {
			const { stdout } = await run(
				process.execPath,
				["--import", join(dir, "register.mjs"), join(dir, "time.mjs"), pathToFileURL(entry).href],
				{ env: { ...process.env, CHECKFU_PLATFORM_EXPORTS: JSON.stringify(exports) } },
			)
			samples.push(Number(stdout))
		}
		return Math.min(...samples)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

const bytes = (files: ReadonlyArray<string>) =>
	files.reduce((sum, file) => sum + statSync(file).size, 0)

export const measureBundle = async (dir: string, entryName: string): Promise<BundleMeasurement> => {
	const scripts = readdirSync(dir)
		.filter((name) => name.endsWith(".js"))
		.map((name) => join(dir, name))
	const eager = eagerClosure(join(dir, entryName))
	return {
		eagerBytes: bytes(eager),
		eagerFiles: eager.map((file) => file.slice(dir.length + 1)).toSorted(),
		totalBytes: bytes(scripts),
		startupCpuMs: await startupCpuMs(join(dir, entryName), platformExports(scripts)),
	}
}

export const API_WORKER_BUDGET = {
	eagerBytes: 2_600_000,
	totalBytes: 2_800_000,
	startupCpuMs: 1000,
} as const

export const EAGER_BYTES_HELP =
	"Every isolate, each Durable Object's included, parses and runs this code before its first event. Import what only one path needs from that path, or lower the budget if the bundle shrank."

export const STARTUP_HELP =
	"Cloudflare rejects a Worker whose global scope needs more than one second of CPU (error 10021). Keep schema and layer construction out of module scope."
