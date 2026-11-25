import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

const SHIM = `#!/bin/sh
hook="$(git rev-parse --show-toplevel)/.githooks/pre-commit"
[ -x "$hook" ] || exit 0
exec "$hook" "$@"
`

const git = (...args) => {
	const result = spawnSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
	return result.status === 0 ? result.stdout.replace(/\r?\n$/, "") : undefined
}

const read = (path) => {
	try {
		return readFileSync(path, "utf8")
	} catch {
		return undefined
	}
}

const skip = (why) =>
	process.stderr.write(`githooks: .githooks/pre-commit is not installed: ${why}\n`)

const real = (path) => {
	try {
		return realpathSync(path)
	} catch {
		return undefined
	}
}

const top = git("rev-parse", "--show-toplevel")
const hooks = git("rev-parse", "--git-path", "hooks")
const root = top === undefined ? undefined : real(top)
if (root !== undefined && hooks !== undefined && root === real(".")) {
	const hook = resolve(hooks, "pre-commit")
	if (git("config", "--get", "core.hooksPath") !== undefined) {
		skip("core.hooksPath is set")
	} else {
		try {
			mkdirSync(dirname(hook), { recursive: true })
			writeFileSync(hook, SHIM, { flag: "wx", mode: 0o755 })
		} catch (error) {
			if (error?.code !== "EEXIST") {
				skip(String(error?.message ?? error))
			} else if (read(hook) !== SHIM) {
				skip(`${hook} already exists`)
			}
		}
	}
}
