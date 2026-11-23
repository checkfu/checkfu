#!/usr/bin/env node
// Trust boundary note: executing this file directly via its `#!/usr/bin/env node` shebang
// (or a PATH-based `checkfu` shim) relies on `node` on the caller's PATH being trusted before
// this launcher runs. In an untrusted working directory where PATH may contain empty, relative,
// or project-local entries, invoke this launcher with a trusted absolute Node binary path
// (for example `/usr/bin/node apps/cli/bin/checkfu.mjs ...`).
import { spawn } from "node:child_process"
import { realpathSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { resolveBunExecutable } from "./resolve-bun.mjs"
import { createLauncherSigintBridge } from "./sigint-bridge.mjs"

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

const hasTerminal =
	Boolean(process.stdin.isTTY) || Boolean(process.stdout.isTTY) || Boolean(process.stderr.isTTY)

const isChildAlive = () => child.exitCode === null && child.signalCode === null

const forwardSignal = (signal) => {
	if (isChildAlive()) {
		child.kill(signal)
	}
}

const sendIpcSigint = () => {
	if (!child.connected || !isChildAlive()) {
		return false
	}
	try {
		child.send({ type: "checkfu:sigint" }, () => {})
		return true
	} catch {
		return false
	}
}

const sigintBridge = createLauncherSigintBridge({
	hasTerminal,
	isChildAlive,
	isConnected: () => child.connected,
	sendIpcSigint,
	forwardOsSigint: () => forwardSignal("SIGINT"),
})

child.on("message", (message) => {
	if (
		typeof message === "object" &&
		message !== null &&
		"type" in message &&
		message.type === "checkfu:sigint-ready"
	) {
		sigintBridge.onReady()
	}
})

child.on("disconnect", () => {
	sigintBridge.onDisconnect()
})

const onSigint = () => sigintBridge.onSigint()
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
