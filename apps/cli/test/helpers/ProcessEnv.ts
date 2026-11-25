export const cliProcessEnv = (
	extra: Readonly<Record<string, string>> = {},
	platform: NodeJS.Platform = process.platform,
	source: NodeJS.ProcessEnv = process.env,
) => {
	const comparable = (name: string) => (platform === "win32" ? name.toUpperCase() : name)
	const env = Object.fromEntries(
		Object.entries(source).filter(
			(entry): entry is [string, string] =>
				entry[1] !== undefined &&
				!comparable(entry[0]).startsWith("CHECKFU_") &&
				comparable(entry[0]) !== "BUN_OPTIONS",
		),
	)
	return { ...env, ...extra }
}
