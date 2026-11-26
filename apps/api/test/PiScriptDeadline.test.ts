import * as source from "@earendil-works/pi-codemode/source"
import { describe, expect, it } from "@effect/vitest"
import { SCRIPT_LIMITS, clampScriptOptions } from "../src/Pi/PiCodemode.ts"

const deadline = { defaultMs: 120_000, maxMs: 300_000 }

const clamp = (code: string) =>
	clampScriptOptions(source, code, deadline, SCRIPT_LIMITS.maxOutputTokens)

const optionsOf = (code: string) => source.parseCodemodeSource(code).options

describe("The options a script runs with", () => {
	it("gives a script that names no deadline the default, for Pi to keep across restarts", () => {
		const clamped = clamp("await tools.read({});")
		expect(clamped).toBeDefined()
		expect(optionsOf(clamped ?? "")).toEqual({ timeoutMs: 120_000 })
		expect(source.parseCodemodeSource(clamped ?? "").code).toBe("\nawait tools.read({});")
	})

	it("caps a requested deadline and output budget, keeping the script's own line numbers", () => {
		const code = '// @options: {"max_output_tokens": 1000000, "timeout_ms": 10000000}\nreturn 1'
		const clamped = clamp(code) ?? ""
		expect(optionsOf(clamped)).toEqual({
			maxOutputTokens: SCRIPT_LIMITS.maxOutputTokens,
			timeoutMs: 300_000,
		})
		expect(source.parseCodemodeSource(clamped).code).toBe(source.parseCodemodeSource(code).code)
	})

	it("leaves a script within the caps unchanged, so a second pass changes nothing", () => {
		const within = '// @options: {"max_output_tokens": 500, "timeout_ms": 1000}\nreturn 1'
		expect(clamp(within)).toBeUndefined()
		const once = clamp("return 1") ?? ""
		expect(clamp(once)).toBeUndefined()
	})

	it("leaves a script Pi will refuse to Pi", () => {
		expect(clamp("")).toBeUndefined()
		expect(clamp('// @options: {"bad": 1}\nreturn 1')).toBeUndefined()
		expect(clamp('return 1\n// @options: {"timeout_ms": 5}')).toBeUndefined()
	})
})
