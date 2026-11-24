/**
 * The environment for a CLI started as a subprocess: the test runner's own, without
 * the caller's CHECKFU_ variables, so a developer's exported key can neither change a
 * result nor appear in a failure, and without BUN_OPTIONS, whose flags the CLI refuses.
 * Tests of those cases set them explicitly.
 */
export const cliProcessEnv = (extra: Readonly<Record<string, string>> = {}) => {
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			(entry): entry is [string, string] =>
				entry[1] !== undefined && !entry[0].startsWith("CHECKFU_") && entry[0] !== "BUN_OPTIONS",
		),
	)
	return { ...env, ...extra }
}
