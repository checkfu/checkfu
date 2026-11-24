// Names of the tools a session offers on its own, kept here so the API Worker can refuse a custom
// tool that would take one without loading Pi or the workspace. PiToolNames.test.ts holds each
// list equal to the one the harness uses.
export const CODEMODE_TOOL = "codemode"
export const TOOL_SEARCH_TOOL = "tool_search"
export const BUILT_IN_WORKSPACE_TOOLS = [
	"read",
	"ls",
	"find",
	"grep",
	"write",
	"edit",
	"delete",
] as const

/** Whether a custom tool may not take this name: it would replace, or pass for, a tool of the session's own. */
export const isReservedToolName = (name: string): boolean =>
	name.startsWith("mcp__") ||
	name.startsWith("api__") ||
	name === CODEMODE_TOOL ||
	name === TOOL_SEARCH_TOOL ||
	BUILT_IN_WORKSPACE_TOOLS.some((builtIn) => builtIn === name)
