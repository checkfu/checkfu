import { spawnSync } from "node:child_process"
import { describe, expect, it } from "@effect/vitest"
import {
	MAX_SHOWN_ARGUMENT_CHARACTERS,
	answerHint,
	describeWaitingCall,
	shellQuote,
} from "../src/Commands/SessionsConnect.ts"

describe("answering a waiting call from the terminal", () => {
	it("prints a command the shell reads back exactly", () => {
		const hint = answerHint("sess_1", "tu_7", "confirmation")
		expect(hint).toBe(
			`checkfu sessions:events send --session-id sess_1 --event '{"type":"user.tool_confirmation","tool_use_id":"tu_7","result":"allow"}'`,
		)
		const tricky = `it's "quoted" $HOME`
		const echoed = spawnSync("sh", ["-c", `printf %s ${shellQuote(tricky)}`], { encoding: "utf8" })
		expect(echoed.stdout).toBe(tricky)
	})

	it("prints a result for a custom tool, and a hint that names both answers for a call it did not see", () => {
		expect(answerHint("sess_1", "tu_8", "result")).toContain('"type":"user.custom_tool_result"')
		expect(answerHint("sess_1", "tu_9", undefined)).toBe(
			"tu_9 waits: answer it with a user.tool_confirmation or a user.custom_tool_result event",
		)
	})

	it("shows the server, the tool and the arguments before the command that allows the call", () => {
		const lines = describeWaitingCall("sess_1", "tu_7", {
			awaits: "confirmation",
			name: "delete_branch",
			server: "github",
			input: { repo: "acme/site", branch: "main\u001b[2J" },
		})
		expect(lines[0]).toBe("[waits] github: delete_branch (tu_7)")
		expect(lines[1]).toBe(String.raw`  arguments: {"repo":"acme/site","branch":"main\u001b[2J"}`)
		expect(lines[2]).toBe(`  allow: ${answerHint("sess_1", "tu_7", "confirmation")}`)
		expect(lines).toHaveLength(3)

		const custom = describeWaitingCall("sess_1", "tu_8", {
			awaits: "result",
			name: "lookup_order",
			server: undefined,
			input: { order: 42 },
		})
		expect(custom[0]).toBe("[waits] custom tool lookup_order (tu_8)")
		expect(custom[2]).toContain("answer: checkfu sessions:events send")
	})

	it("bounds long arguments, and offers no approval for a call it did not see", () => {
		const long = describeWaitingCall("sess_1", "tu_7", {
			awaits: "confirmation",
			name: "write",
			server: "docs",
			input: { text: "😀".repeat(5000) },
		})
		const shown = long[1]!.slice("  arguments: ".length)
		expect(Array.from(shown.split("…")[0]!)).toHaveLength(MAX_SHOWN_ARGUMENT_CHARACTERS)
		expect(shown).toMatch(/… \(\d+ more characters\)$/u)

		const unseen = describeWaitingCall("sess_1", "tu_9", undefined)
		expect(unseen[0]).toBe("[waits] tu_9: read its use event before answering")
		expect(unseen[1]).toBe("  show: checkfu sessions:events list --session-id sess_1")
		expect(unseen.join("\n")).not.toContain('"result":"allow"')
	})
})
