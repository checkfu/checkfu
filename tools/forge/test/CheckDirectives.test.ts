import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
	checkDirectiveFiles,
	findDirectiveViolationsInSource,
	shouldCheckFile,
} from "../src/CheckDirectives.ts"

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

	it("parses JSX text apostrophes without skipping subsequent directive comments", () => {
		const tsx = [
			"export const Notice = () => <p>Don't retry</p>",
			"//" + " oxlint-disable-next-line no-debugger",
			"debugger",
			"export const Inline = () => <div>{/*" + " oxlint-disable " + "*/}</div>",
		].join("\n")
		expect(findDirectiveViolationsInSource("src/Notice.tsx", tsx)).toEqual([
			{ file: "src/Notice.tsx", line: 2, directive: "oxlint-disable-next-line" },
			{ file: "src/Notice.tsx", line: 4, directive: "oxlint-disable" },
		])
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

	it("catches directives after division, object literal division, multiline comments, and template expressions", () => {
		const afterDivision = "const q = total / 2 //" + " oxlint-disable-line\n"
		expect(findDirectiveViolationsInSource("src/div.ts", afterDivision)).toEqual([
			{ file: "src/div.ts", line: 1, directive: "oxlint-disable-line" },
		])

		const afterObjectDivision =
			"const ratio = { valueOf: () => 4 } / 2 //" + " oxlint-disable-line\n"
		expect(findDirectiveViolationsInSource("src/obj-div.ts", afterObjectDivision)).toEqual([
			{ file: "src/obj-div.ts", line: 1, directive: "oxlint-disable-line" },
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

	it("checks non-ASCII filenames returned by git ls-files -z without core.quotePath filtering", () => {
		const tmpRepo = mkdtempSync(join(tmpdir(), "checkfu-directives-"))
		try {
			execFileSync("git", ["init", "-q"], { cwd: tmpRepo })
			const nonAsciiFile = "caf\u00E9.ts"
			writeFileSync(
				join(tmpRepo, nonAsciiFile),
				`const emoji = "\u2615\uD83D\uDE80"\n/${"*"} oxlint-disable ${"*"}/\ndebugger\n`,
			)
			execFileSync("git", ["add", nonAsciiFile], { cwd: tmpRepo })
			expect(checkDirectiveFiles(["."], tmpRepo)).toEqual([
				{ file: nonAsciiFile, line: 2, directive: "oxlint-disable" },
			])
		} finally {
			rmSync(tmpRepo, { recursive: true, force: true })
		}
	})

	it("exempts only exact routeTree.gen.ts basenames and non-source files", () => {
		expect(shouldCheckFile("apps/app/src/routeTree.gen.ts")).toBe(false)
		expect(shouldCheckFile("routeTree.gen.ts")).toBe(false)
		expect(shouldCheckFile("src/custom-routeTree.gen.ts")).toBe(true)
		expect(shouldCheckFile("README.md")).toBe(false)
		expect(shouldCheckFile("apps/api/src/ApiWorker.ts")).toBe(true)
	})
})
