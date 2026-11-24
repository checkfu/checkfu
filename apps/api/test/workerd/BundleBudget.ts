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
		}
	} finally {
		rmSync(scratch, { recursive: true, force: true })
	}
}

export const API_WORKER_BUDGET = {
	eagerBytes: 1_500_000,
	totalBytes: 1_500_000,
	startupCpuMs: 1000,
} as const

export const PI_HARNESS_WORKER_BUDGET = {
	eagerBytes: 2_000_000,
	totalBytes: 2_950_000,
	startupCpuMs: 1000,
} as const

export const HARNESS_SOURCES_HELP =
	"The API Worker bundled code that belongs to the harness Worker. Import the harness through apps/api/src/Pi/PiHarness.ts, PiCatalog.ts or a type-only import, so the public Worker never loads provider SDKs or Pi."

export const EAGER_BYTES_HELP =
	"Every isolate, each Durable Object's included, parses and runs this code before its first event. Import what only one path needs from that path, or lower the budget if the bundle shrank."

export const STARTUP_HELP =
	"Cloudflare rejects a Worker whose global scope needs more than one second of CPU (error 10021). Keep schema and layer construction out of module scope."
