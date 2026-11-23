#!/usr/bin/env node
// Trust boundary note:
// - Executing via `#!/usr/bin/env node` (or a PATH-based `checkfu` shim) relies on both
//   `checkfu` and `node` on the caller's PATH resolving to trusted installations before this
//   launcher runs.
// - In an untrusted checkout with CHECKFU_API_KEY exported (or a PATH that may include empty,
//   relative, or checkout-local entries), invoke an independently installed launcher using
//   absolute paths for BOTH Node and `checkfu.mjs` (for example
//   `/usr/bin/node /opt/checkfu/apps/cli/bin/checkfu.mjs ...`).
import { spawn } from "node:child_process"
import { realpathSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { resolveBunExecutable } from "./resolve-bun.mjs"
import { createLauncherSigintBridge } from "./sigint-bridge.mjs"

// oxlint-disable-next-line unicorn/prefer-import-meta-properties -- preserve compatibility with Node < 20.11 where import.meta.filename is undefined
const launcherPath = realpathSync(fileURLToPath(import.meta.url))
const cliRoot = resolve(dirname(launcherPath), "..")
const bunfigPath = resolve(cliRoot, "bunfig.toml")
const mainPath = resolve(cliRoot, "src", "main.ts")
const bunExecutable = resolveBunExecutable()

if (bunExecutable === null) {
	process.stderr.write(
		"Error: Could not find a trusted Bun executable in standard installation directories (PATH entries outside trusted installation roots and checkout-local directories are ignored). Install Bun to ~/.bun/bin (or a standard system/package-manager directory), or set BUN_INSTALL or CHECKFU_BUN_PATH to a trusted absolute installation outside the current checkout.\n",
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
