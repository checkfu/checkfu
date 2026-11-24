/**
 * The environment for a CLI started as a subprocess: the test runner's own, without
 * the caller's CHECKFU_ variables, so a developer's exported key can neither change a
 * result nor appear in a failure, and without BUN_OPTIONS, whose flags the CLI refuses.
 * Tests of those cases set them explicitly.
 *
 * Windows treats environment names case-insensitively, so there `Bun_Options` or
 * `Checkfu_Api_Key` are removed too. Entries that are kept keep their spelling.
 */
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
