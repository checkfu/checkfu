#!/usr/bin/env node
import { spawn } from "node:child_process"
import { realpathSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const launcherPath = realpathSync(fileURLToPath(import.meta.url))
const cliRoot = resolve(dirname(launcherPath), "..")
const bunfigPath = resolve(cliRoot, "bunfig.toml")
const mainPath = resolve(cliRoot, "src", "main.ts")
const bunExecutable = "bun"

const child = spawn(
	bunExecutable,
	["--no-env-file", `--config=${bunfigPath}`, mainPath, ...process.argv.slice(2)],
	{ stdio: "inherit" },
)

// When attached to a terminal, Ctrl-C sends SIGINT to the entire foreground
// process group (both launcher and child Bun process), so the launcher ignores
// SIGINT and lets Bun handle first-Ctrl-C interrupt vs second-Ctrl-C disconnect.
// When detached from any TTY, forward SIGINT explicitly to the child process.
const hasTerminal =
	Boolean(process.stdin.isTTY) || Boolean(process.stdout.isTTY) || Boolean(process.stderr.isTTY)

const forwardSignal = (signal) => {
	if (child.exitCode === null && child.signalCode === null) {
		child.kill(signal)
	}
}
const onSigint = () => {
	if (!hasTerminal) {
		forwardSignal("SIGINT")
	}
}
const onSigterm = () => forwardSignal("SIGTERM")
const onSighup = () => forwardSignal("SIGHUP")

process.on("SIGINT", onSigint)
process.on("SIGTERM", onSigterm)
if (process.platform !== "win32") {
	process.on("SIGHUP", onSighup)
}

child.on("error", (err) => {
	process.stderr.write(`Error: Failed to launch Checkfu CLI via ${bunExecutable}: ${err.message}\n`)
	process.exit(1)
})

child.on("exit", (code, signal) => {
	process.removeListener("SIGINT", onSigint)
	process.removeListener("SIGTERM", onSigterm)
	if (process.platform !== "win32") {
		process.removeListener("SIGHUP", onSighup)
	}
	if (code !== null) {
		process.exit(code)
	}
	if (signal !== null) {
		if (process.platform === "win32") {
			process.exit(1)
		}
		process.kill(process.pid, signal)
		return
	}
	process.exit(1)
})
