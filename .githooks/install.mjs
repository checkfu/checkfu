import { spawnSync } from "node:child_process"
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

// Run by `bun install`. Adds a pre-commit hook that runs the committing worktree's
// .githooks/pre-commit where no hook exists yet, and never changes a file that does.

const SHIM = `#!/bin/sh
hook="$(git rev-parse --show-toplevel)/.githooks/pre-commit"
[ -x "$hook" ] || exit 0
exec "$hook" "$@"
`

const git = (...args) => {
	const result = spawnSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
	return result.status === 0 ? result.stdout.trim() : undefined
}

const contents = (path) => {
	try {
		lstatSync(path)
	} catch {
		return undefined
	}
	try {
		return readFileSync(path, "utf8")
	} catch {
		return null
	}
}

const top = git("rev-parse", "--show-toplevel")
const hooks = git("rev-parse", "--git-path", "hooks")
if (top !== undefined && hooks !== undefined && realpathSync(top) === realpathSync(".")) {
	const hook = resolve(hooks, "pre-commit")
	const existing = contents(hook)
	if (git("config", "--get", "core.hooksPath") !== undefined) {
		process.stderr.write(
			"githooks: core.hooksPath is set, so .githooks/pre-commit is not installed\n",
		)
	} else if (existing === undefined) {
		mkdirSync(dirname(hook), { recursive: true })
		writeFileSync(hook, SHIM)
		chmodSync(hook, 0o755)
	} else if (existing !== SHIM) {
		process.stderr.write(
			`githooks: ${hook} already exists, so .githooks/pre-commit is not installed\n`,
		)
	}
}
