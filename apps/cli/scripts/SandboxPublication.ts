import { sandboxPublication } from "./Registry.ts"

const tag = process.argv[2] ?? ""
const user = process.env["GITHUB_ACTOR"] ?? ""
const token = process.env["REGISTRY_TOKEN"] ?? ""
try {
	const availability = await sandboxPublication(tag, { user, token })
	process.stdout.write(`${availability}\n`)
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : "Registry check failed."}\n`)
	process.exitCode = 1
}
