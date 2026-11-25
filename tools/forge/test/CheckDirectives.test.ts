import { describe, expect, it } from "vitest"
import { findDirectiveViolationsInSource, shouldCheckFile } from "../src/CheckDirectives.ts"

describe("CheckDirectives", () => {
	it("rejects blanket and line-level lint, ts, and effect suppression directives", () => {
		const blanket = ["/" + "* oxlint-disable *" + "/", "debugger"].join("\n")
		expect(findDirectiveViolationsInSource("src/a.ts", blanket)).toEqual([
			{ file: "src/a.ts", line: 1, directive: "oxlint-disable" },
		])

		const cases = [
			["//" + " oxlint-disable-next-line no-console", "oxlint-disable-next-line"],
			["//" + " oxlint-disable-line", "oxlint-disable-line"],
			["/*" + " eslint-disable " + "*/", "eslint-disable"],
			["//" + " eslint-disable-next-line", "eslint-disable-next-line"],
			["//" + " @ts-" + "expect-error -- boundary: nope", "@" + "ts-expect-error"],
			["//" + " @ts-" + "ignore", "@" + "ts-ignore"],
			["//" + " @ts-" + "nocheck", "@" + "ts-nocheck"],
			[
				"// @" + "effect-diagnostics-next-line leakingRequirements:off",
				"@" + "effect-diagnostics-next-line",
			],
		] as const

		for (const [snippet, expected] of cases) {
			expect(findDirectiveViolationsInSource("src/b.ts", `\n${snippet}\nconst x = 1\n`)).toEqual([
				{ file: "src/b.ts", line: 2, directive: expected },
			])
		}
	})

	it("ignores string literals, template literals, regexes, and @effect-expect-leaking contracts", () => {
		const clean = [
			'const s = "oxlint-disable eslint-disable @" + "ts-ignore"',
			"const t = `prefix ${1 + 1} /* oxlint-disable */ suffix`",
			String.raw`const r = /oxlint-disable\/eslint-disable/u`,
			"/**" + " @effect-expect-leaking RuntimeContext *" + "/",
			"const q = 10 / 2",
		].join("\n")
		expect(findDirectiveViolationsInSource("src/clean.ts", clean)).toEqual([])
	})

	it("catches directives after division, property-named keywords, multiline comments, and template expressions", () => {
		const afterDivision = "const q = total / 2 //" + " oxlint-disable-line\n"
		expect(findDirectiveViolationsInSource("src/div.ts", afterDivision)).toEqual([
			{ file: "src/div.ts", line: 1, directive: "oxlint-disable-line" },
		])

		const afterPropKeyword = "const q = obj.return / 2 //" + " oxlint-disable-line\n"
		expect(findDirectiveViolationsInSource("src/prop.ts", afterPropKeyword)).toEqual([
			{ file: "src/prop.ts", line: 1, directive: "oxlint-disable-line" },
		])

		const multiline = ["/*", "  header", "  oxlint-" + "disable", "*/"].join("\n")
		expect(findDirectiveViolationsInSource("src/multi.ts", multiline)).toEqual([
			{ file: "src/multi.ts", line: 3, directive: "oxlint-disable" },
		])

		const inTemplateExpr = "const s = `${foo(/*" + " oxlint-disable " + "*/ 1)}`\n"
		expect(findDirectiveViolationsInSource("src/tpl.ts", inTemplateExpr)).toEqual([
			{ file: "src/tpl.ts", line: 1, directive: "oxlint-disable" },
		])
	})

	it("skips routeTree.gen.ts and non-source files", () => {
		expect(shouldCheckFile("apps/app/src/routeTree.gen.ts")).toBe(false)
		expect(shouldCheckFile("README.md")).toBe(false)
		expect(shouldCheckFile("apps/api/src/ApiWorker.ts")).toBe(true)
	})
})
