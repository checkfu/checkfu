import { execFileSync } from "node:child_process"
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { prepareEvidenceDirectory } from "./VerifyDirectory.ts"

it("validates each evidence file before creating or writing any output", () => {
	const scratch = realpathSync(mkdtempSync(join(tmpdir(), "checkfu-evidence-paths-")))
	try {
		const checkout = join(scratch, "checkout")
		mkdirSync(checkout)
		const git = (...args: Array<string>) => execFileSync("git", args, { cwd: checkout })
		git("init", "--quiet")
		writeFileSync(join(checkout, ".gitignore"), ".checkfu/\n")
		const ignored = join(checkout, ".checkfu", "verification")
		mkdirSync(ignored, { recursive: true })
		const report = ["matrix.json", "summary.md"]
		const group = [...report, "ui.json", "ui.vitest.json"]
		const visible = join(checkout, "visible", "nested")
		expect(() => prepareEvidenceDirectory(checkout, visible, group)).toThrow(
			"Unsafe verification output path",
		)
		expect(existsSync(visible)).toBe(false)

		const external = join(scratch, "external", "nested")
		expect(prepareEvidenceDirectory(checkout, external, group)).toBe(external)
		expect(prepareEvidenceDirectory(checkout, ignored, group)).toBe(ignored)
		const nested = join(ignored, "not-created")
		expect(prepareEvidenceDirectory(checkout, nested, group)).toBe(nested)
		expect(existsSync(nested)).toBe(false)

		const trackedReceipt = join(ignored, "ui.json")
		writeFileSync(trackedReceipt, "tracked original\n")
		git("add", "--force", "--", trackedReceipt)
		expect(prepareEvidenceDirectory(checkout, ignored, report)).toBe(ignored)
		expect(() => prepareEvidenceDirectory(checkout, ignored, group)).toThrow(trackedReceipt)
		expect(readFileSync(trackedReceipt, "utf8")).toBe("tracked original\n")
		expect(() => prepareEvidenceDirectory(checkout, external, group, trackedReceipt)).toThrow(
			trackedReceipt,
		)

		const mixedCase = join(ignored, "Summary.md")
		writeFileSync(mixedCase, "tracked case original\n")
		git("add", "--force", "--", mixedCase)
		if (existsSync(join(ignored, "summary.md"))) {
			expect(() => prepareEvidenceDirectory(checkout, ignored, report)).toThrow(
				"Unsafe verification output path",
			)
		} else {
			expect(prepareEvidenceDirectory(checkout, ignored, report)).toBe(ignored)
		}
		expect(readFileSync(mixedCase, "utf8")).toBe("tracked case original\n")

		const alias = join(scratch, "ignored-alias")
		symlinkSync(ignored, alias, "junction")
		expect(prepareEvidenceDirectory(checkout, join(alias, "elsewhere"), group)).toBe(
			join(ignored, "elsewhere"),
		)
		const backInside = join(scratch, "source-alias")
		symlinkSync(checkout, backInside, "junction")
		expect(() => prepareEvidenceDirectory(checkout, join(backInside, "exposed"), report)).toThrow(
			"Unsafe verification output path",
		)
		const overwritten = join(ignored, "matrix.json")
		symlinkSync(trackedReceipt, overwritten, "file")
		expect(() => prepareEvidenceDirectory(checkout, ignored, report)).toThrow(overwritten)
		expect(readFileSync(trackedReceipt, "utf8")).toBe("tracked original\n")
	} finally {
		rmSync(scratch, { recursive: true, force: true })
	}
})
