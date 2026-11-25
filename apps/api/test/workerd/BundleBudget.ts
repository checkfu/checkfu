import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import * as Schema from "effect/Schema"

const PROBE = fileURLToPath(new URL("./StartupProbe.mjs", import.meta.url))
const SAMPLES = 3
// All samples together end before the 60 seconds the test that calls this is given.
const PROBE_TIMEOUT_MS = 15_000

const ProbeResult = Schema.fromJsonString(
	Schema.Struct({ cpuMs: Schema.Finite, loaded: Schema.Array(Schema.String) }),
)

export interface BundleMeasurement {
	readonly eagerBytes: number
	readonly eagerFiles: ReadonlyArray<string>
	readonly totalBytes: number
	readonly startupCpuMs: number
	readonly harnessSources: ReadonlyArray<string>
	// The largest sources of the eager code, by bytes, read from the source maps: a package for
	// a dependency, a file for the repository's own code.
	readonly eagerContributors: ReadonlyArray<{ readonly source: string; readonly bytes: number }>
}

// Every sample is a cold import in plain Node, whatever the caller's environment: no compile
// cache to reuse code compiled by an earlier sample, and none of the caller's Node options.
const probeEnv = (): NodeJS.ProcessEnv => {
	const { NODE_OPTIONS: _ignored, ...inherited } = process.env
	return { ...inherited, NODE_DISABLE_COMPILE_CACHE: "1" }
}

const HARNESS_SOURCE =
	/node_modules\/(?:openai|agents|@anthropic-ai\/[^/]+|@earendil-works\/[^/]+)\/[^"]*/
const MODEL_TABLE =
	/@earendil-works\/pi-ai\/dist\/(?:model-catalog\.js|providers\/(?:data\/[^/]+\.json|[^/]+\.models\.js))$/

// Every file under the bundle, at any depth, so no check sees less than what ships.
const bundleFiles = (root: string): ReadonlyArray<string> =>
	readdirSync(root, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name))

const harnessSources = (root: string): ReadonlyArray<string> =>
	bundleFiles(root)
		.filter((file) => file.endsWith(".js.map"))
		.flatMap((file) => {
			const map = JSON.parse(readFileSync(file, "utf8")) as {
				readonly sources?: ReadonlyArray<string>
			}
			return map.sources ?? []
		})
		.filter((source) => HARNESS_SOURCE.test(source) && !MODEL_TABLE.test(source))
		.toSorted()

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

// Source map "mappings": per generated line, segments of base64 VLQ fields. Only the first two
// are needed, the generated column (relative within a line) and the source (relative overall);
// a segment with a column alone starts an unmapped range.
const decodeMappings = (
	mappings: string,
): ReadonlyArray<ReadonlyArray<readonly [number, number | undefined]>> => {
	let source = 0
	return mappings.split(";").map((line) => {
		let column = 0
		const segments: Array<readonly [number, number | undefined]> = []
		for (const segment of line.split(",")) {
			const fields: Array<number> = []
			let value = 0
			let shift = 0
			for (const char of segment) {
				const digit = BASE64.indexOf(char)
				value += (digit & 31) << shift
				if (digit & 32) {
					shift += 5
				} else {
					fields.push(value & 1 ? -(value >>> 1) : value >>> 1)
					value = 0
					shift = 0
				}
			}
			if (fields.length === 0) {
				continue
			}
			column += fields[0] ?? 0
			if (fields.length >= 2) {
				source += fields[1] ?? 0
			}
			segments.push([column, fields.length >= 2 ? source : undefined])
		}
		return segments
	})
}

const contributorOf = (source: string): string => {
	const dependency = source.match(
		/node_modules\/(?:\.bun\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/,
	)
	return dependency?.[1] ?? source.replace(/^(?:\.\.\/)+/, "")
}

const eagerContributors = (files: ReadonlyArray<string>, top = 12) => {
	const bytesBySource = new Map<string, number>()
	for (const file of files) {
		let map: { readonly sources?: ReadonlyArray<string>; readonly mappings?: string }
		try {
			map = JSON.parse(readFileSync(`${file}.map`, "utf8")) as typeof map
		} catch {
			continue
		}
		const lines = readFileSync(file, "utf8").split("\n")
		decodeMappings(map.mappings ?? "").forEach((segments, index) => {
			segments.forEach(([column, source], at) => {
				if (source === undefined) {
					return
				}
				// Columns count UTF-16 code units; the budget counts UTF-8 bytes.
				const span = lines[index]?.slice(column, segments[at + 1]?.[0]) ?? ""
				const key = contributorOf(map.sources?.[source] ?? "unknown")
				bytesBySource.set(key, (bytesBySource.get(key) ?? 0) + Buffer.byteLength(span, "utf8"))
			})
		})
	}
	return [...bytesBySource]
		.toSorted((a, b) => b[1] - a[1])
		.slice(0, top)
		.map(([source, bytes]) => ({ source, bytes }))
}

const probe = async (entry: string, resultFile: string, timeout: number) => {
	const child = spawn(process.execPath, [PROBE, pathToFileURL(entry).href, resultFile], {
		env: probeEnv(),
		// The entry's own output goes nowhere; the result comes back in the file.
		stdio: ["ignore", "ignore", "inherit"],
		timeout,
		killSignal: "SIGKILL",
	})
	const [code, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null]
	if (code !== 0) {
		throw new Error(
			`The start-up probe of ${entry} ended with ${signal ?? `exit code ${code}`} instead of a result.`,
		)
	}
	return Schema.decodeSync(ProbeResult)(readFileSync(resultFile, "utf8"))
}

const bytes = (files: ReadonlyArray<string>) =>
	files.reduce((sum, file) => sum + statSync(file).size, 0)

/**
 * Evaluates the entry under Node with the platform modules stubbed. `eagerFiles` are the
 * bundle's modules Node loaded doing so. `startupCpuMs` is the CPU that took, the work
 * Cloudflare bounds at one second (error 10021); it tracks the trend, not Cloudflare's number.
 */
export const measureBundle = async (
	dir: string,
	entryName: string,
	probeTimeoutMs = PROBE_TIMEOUT_MS,
): Promise<BundleMeasurement> => {
	const root = realpathSync(dir)
	const scratch = mkdtempSync(join(tmpdir(), "checkfu-startup-"))
	try {
		const samples: Array<typeof ProbeResult.Type> = []
		for (let sample = 0; sample < SAMPLES; sample++) {
			samples.push(
				await probe(join(root, entryName), join(scratch, `${sample}.json`), probeTimeoutMs),
			)
		}
		const inBundle = pathToFileURL(root + sep).href
		const eager = (samples[0]?.loaded ?? [])
			.filter((url) => url.startsWith(inBundle))
			.map((url) => fileURLToPath(url))
		return {
			eagerBytes: bytes(eager),
			eagerFiles: eager.map((file) => file.slice(root.length + 1)).toSorted(),
			totalBytes: bytes(bundleFiles(root).filter((file) => !file.endsWith(".map"))),
			startupCpuMs: Math.min(...samples.map((sample) => sample.cpuMs)),
			harnessSources: harnessSources(root),
			eagerContributors: eagerContributors(eager),
		}
	} finally {
		rmSync(scratch, { recursive: true, force: true })
	}
}

// Each byte budget is what the Worker measured when it was last set, plus about 25 KB. The
// start-up budget is half of Cloudflare's one second, so the trend is caught with room to act.
export const API_WORKER_BUDGET = {
	eagerBytes: 1_270_000,
	totalBytes: 1_270_000,
	startupCpuMs: 500,
} as const

export const CONTENT_WORKER_BUDGET = {
	eagerBytes: 555_000,
	totalBytes: 555_000,
	startupCpuMs: 500,
} as const

export const PI_HARNESS_WORKER_BUDGET = {
	eagerBytes: 1_855_000,
	totalBytes: 1_985_000,
	startupCpuMs: 500,
} as const

export const HARNESS_SOURCES_HELP =
	"The API Worker bundled code that belongs to the harness Worker. Import the harness through apps/api/src/Pi/PiHarness.ts, PiCatalog.ts or a type-only import, so the public Worker never loads provider SDKs or Pi."

export const describeEager = (worker: string, measured: BundleMeasurement): string =>
	[
		`${worker}: ${measured.eagerBytes} bytes of eager code in ${measured.eagerFiles.join(", ")}. Largest sources:`,
		...measured.eagerContributors.map(
			({ source, bytes }) => `  ${String(bytes).padStart(9)}  ${source}`,
		),
	].join("\n")

export const EAGER_BYTES_HELP =
	"Every isolate, each Durable Object's included, parses and runs this code before its first event. Before raising the budget, look at the largest sources below: data belongs in a static asset or storage, and code only one path needs belongs behind that path or in its own Worker. Lower the budget if the bundle shrank."

export const STARTUP_HELP =
	"Cloudflare rejects a Worker whose global scope needs more than one second of CPU (error 10021); the budget is half that. Keep schema and layer construction out of module scope."
