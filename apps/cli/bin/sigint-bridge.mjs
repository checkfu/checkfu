/**
 * Coordinate launcher SIGINT delivery across startup (before `main.ts` reports IPC
 * readiness) and steady state, ensuring exactly one interrupt for both foreground-group
 * keyboard Ctrl-C and PID-targeted `kill -INT <launcher-pid>` in TTY and non-TTY modes.
 */
export const createLauncherSigintBridge = (options) => {
	let childSigintReady = false
	let pendingStartupSigints = 0

	const onReady = () => {
		childSigintReady = true
		while (pendingStartupSigints > 0) {
			pendingStartupSigints -= 1
			if (!options.sendIpcSigint()) {
				break
			}
		}
	}

	const onDisconnect = () => {
		childSigintReady = false
	}

	const onSigint = () => {
		if (!options.isChildAlive()) {
			return
		}
		if (childSigintReady && options.sendIpcSigint()) {
			return
		}
		// Before `main.ts` reports readiness over IPC:
		// - Retain the startup interrupt while IPC is connected so if Bun already installed
		//   `onOsSigint` (which suppresses duplicate OS SIGINT while IPC is connected) and
		//   survives any OS signal, the interrupt flushes as soon as `checkfu:sigint-ready` arrives.
		// - Without a TTY, also forward OS SIGINT immediately so startup cancels promptly if Bun
		//   has not installed `onOsSigint` yet (or if IPC already disconnected).
		// - With a TTY, wait to forward OS SIGINT until a second startup SIGINT arrives so a
		//   single foreground-group Ctrl-C does not double-deliver before readiness.
		const connected = options.isConnected()
		if (connected) {
			pendingStartupSigints += 1
		}
		if (!options.hasTerminal || !connected || pendingStartupSigints > 1) {
			options.forwardOsSigint()
		}
	}

	return { onSigint, onReady, onDisconnect }
}
