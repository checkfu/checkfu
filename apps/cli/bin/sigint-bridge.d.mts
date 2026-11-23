export interface LauncherSigintBridgeOptions {
	readonly hasTerminal: boolean
	readonly isChildAlive: () => boolean
	readonly isConnected: () => boolean
	readonly sendIpcSigint: () => boolean
	readonly forwardOsSigint: () => void
}

export interface LauncherSigintBridge {
	readonly onSigint: () => void
	readonly onReady: () => void
	readonly onDisconnect: () => void
}

export declare function createLauncherSigintBridge(
	options: LauncherSigintBridgeOptions,
): LauncherSigintBridge
