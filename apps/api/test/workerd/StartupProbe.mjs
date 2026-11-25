import { writeFileSync } from "node:fs"
import { registerHooks } from "node:module"

const [entry, resultFile] = process.argv.slice(2)

const PLATFORM = "checkfu-platform:"
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
process.exit(0)
