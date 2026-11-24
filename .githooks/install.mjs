import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

// Run by `bun install`. Adds a pre-commit hook that runs the committing worktree's
// .githooks/pre-commit where no hook exists yet, never changes a file that does, and
// never fails the install.

const SHIM = `#!/bin/sh
hook="$(git rev-parse --show-toplevel)/.githooks/pre-commit"
[ -x "$hook" ] || exit 0
exec "$hook" "$@"
`

const git = (...args) => {
	const result = spawnSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
	return result.status === 0 ? result.stdout.trim() : undefined
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

const top = git("rev-parse", "--show-toplevel")
const hooks = git("rev-parse", "--git-path", "hooks")
if (top !== undefined && hooks !== undefined && realpathSync(top) === realpathSync(".")) {
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
