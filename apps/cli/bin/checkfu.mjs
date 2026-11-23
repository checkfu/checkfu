#!/usr/bin/env node
import { spawn } from "node:child_process"
import { realpathSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { resolveBunExecutable } from "./resolve-bun.mjs"

const launcherPath = realpathSync(import.meta.filename)
const cliRoot = resolve(dirname(launcherPath), "..")
const bunfigPath = resolve(cliRoot, "bunfig.toml")
const mainPath = resolve(cliRoot, "src", "main.ts")
const bunExecutable = resolveBunExecutable()

if (bunExecutable === null) {
	process.stderr.write(
		"Error: Could not find a trusted Bun executable on PATH or in standard Bun install directories.\n",
	)
	process.exit(1)
}

const child = spawn(
	bunExecutable,
	["--no-env-file", `--config=${bunfigPath}`, mainPath, ...process.argv.slice(2)],
	{
		stdio: ["inherit", "inherit", "inherit", "ipc"],
		serialization: "json",
	},
)

// Coordinate SIGINT over the launcher IPC channel so both keyboard Ctrl-C (delivered to
// the entire foreground process group) and PID-targeted `kill -INT <launcher-pid>` deliver
// exactly one interrupt to the Bun CLI. While connected, `main.ts` ignores duplicate OS
// SIGINT signals and acts solely on `checkfu:sigint` messages from the launcher.
const hasTerminal =
	Boolean(process.stdin.isTTY) || Boolean(process.stdout.isTTY) || Boolean(process.stderr.isTTY)

let childSigintReady = false
let pendingStartupSigints = 0

const forwardSignal = (signal) => {
	if (child.exitCode === null && child.signalCode === null) {
		child.kill(signal)
	}
}

const sendIpcSigint = () => {
	if (!child.connected || child.exitCode !== null || child.signalCode !== null) {
		return false
	}
	try {
		child.send({ type: "checkfu:sigint" }, () => {})
		return true
	} catch {
		return false
	}
}

child.on("message", (message) => {
	if (
		typeof message === "object" &&
		message !== null &&
		"type" in message &&
		message.type === "checkfu:sigint-ready"
	) {
		childSigintReady = true
		while (pendingStartupSigints > 0) {
			pendingStartupSigints -= 1
			if (!sendIpcSigint()) {
				break
			}
		}
	}
})

child.on("disconnect", () => {
	childSigintReady = false
})

const onSigint = () => {
	if (child.exitCode !== null || child.signalCode !== null) {
		return
	}
	if (childSigintReady && sendIpcSigint()) {
		return
	}
	// Before `main.ts` reports readiness over IPC (or if IPC disconnected):
	// - Without a TTY, forward OS SIGINT directly since no process-group Ctrl-C exists.
	// - With a TTY while IPC is connecting, queue the first SIGINT so keyboard Ctrl-C
	//   does not double-deliver and PID-targeted SIGINT flushes once ready; a second
	//   SIGINT forwards OS SIGINT in case Bun stalled before installing its handler.
	if (!hasTerminal) {
		forwardSignal("SIGINT")
		return
	}
	if (child.connected) {
		pendingStartupSigints += 1
		if (pendingStartupSigints > 1) {
			forwardSignal("SIGINT")
		}
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
	if (child.connected) {
		child.disconnect()
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
