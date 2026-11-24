// Runs in its own Node process. Evaluates a Worker entry with the platform modules stubbed,
// then writes the CPU that took and every module Node loaded on the way to a result file.
import { writeFileSync } from "node:fs"
import { registerHooks } from "node:module"

const [entry, resultFile] = process.argv.slice(2)

const PLATFORM = "checkfu-platform:"
// A platform export missing here stops the probe with Node's own
// "does not provide an export named" error, which names it.
const PLATFORM_STUB = `${["DurableObject", "WorkerEntrypoint", "WorkflowEntrypoint"]
	.map(
		(name) => `export class ${name} { constructor(ctx, env) { this.ctx = ctx; this.env = env } }`,
	)
	.join("\n")}\nexport default {}`

const loaded = []
registerHooks({
	resolve: (specifier, context, next) =>
		specifier.startsWith("cloudflare:")
			? { url: PLATFORM + specifier, shortCircuit: true }
			: next(specifier, context),
	load: (url, context, next) => {
		if (url.startsWith(PLATFORM)) {
			return { format: "module", shortCircuit: true, source: PLATFORM_STUB }
		}
		loaded.push(url)
		return next(url, context)
	},
})

const before = process.cpuUsage()
await import(entry)
const used = process.cpuUsage(before)
writeFileSync(resultFile, JSON.stringify({ cpuMs: (used.user + used.system) / 1000, loaded }))
