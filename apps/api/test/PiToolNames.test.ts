import { CODEMODE_TOOL_NAME } from "@earendil-works/pi-durable/codemode"
import { TOOL_SEARCH_TOOL_NAME } from "@earendil-works/pi-durable/tool-search"
import { describe, expect, it } from "@effect/vitest"
import { BUILT_IN_WORKSPACE_TOOLS, CODEMODE_TOOL, TOOL_SEARCH_TOOL } from "../src/Pi/PiToolNames.ts"
import { WORKSPACE_TOOL_NAMES } from "../src/Workspace/WorkspaceTools.ts"

describe("The names a custom tool may not take", () => {
	it("are the names the harness gives its own tools", () => {
		expect(CODEMODE_TOOL).toBe(CODEMODE_TOOL_NAME)
		expect(TOOL_SEARCH_TOOL).toBe(TOOL_SEARCH_TOOL_NAME)
		expect([...BUILT_IN_WORKSPACE_TOOLS]).toEqual([...WORKSPACE_TOOL_NAMES])
	})
})
