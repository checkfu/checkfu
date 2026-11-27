import { parseProjectDocument } from "@checkfu/authoring/document"
import { maxProjectSourceBytes } from "@checkfu/authoring/project"
import { describe, expect, it } from "@effect/vitest"

describe("project documents", () => {
	it.each([
		["YAML", "name: report\n", "mapping", { body: { name: "report" } }],
		["YAML with a BOM", "\uFEFFname: report\n", "mapping", { body: { name: "report" } }],
		[
			"Markdown frontmatter and prose",
			"---\nname: report\n---\n\nHello\n",
			"auto",
			{ body: { name: "report" }, hasFrontmatter: true, prose: "Hello" },
		],
	] as const)("parses %s", (_name, source, format, expected) => {
		expect(parseProjectDocument(source, format)).toMatchObject(expected)
	})

	it.each([
		["unterminated frontmatter", "---\nname: report\n\nHello\n", "markdown", "closing ---"],
		["a YAML alias", "first: &value 1\nsecond: *value\n", "mapping", undefined],
		["duplicate keys", "name: first\nname: second\n", "mapping", undefined],
		["a top-level sequence", "- one\n- two\n", "mapping", undefined],
		["oversized ASCII", "a".repeat(maxProjectSourceBytes + 1), "mapping", "2 MiB"],
		["oversized UTF-8", "é".repeat(maxProjectSourceBytes / 2 + 1), "mapping", "2 MiB"],
	] as const)("rejects %s", (_name, source, format, message) => {
		expect(() => parseProjectDocument(source, format)).toThrow(message)
	})

	it("keeps the object prototype free of YAML data", () => {
		const project = parseProjectDocument("__proto__: { fixture: true }\n", "mapping")
		expect(Object.getPrototypeOf(project.body)).toBe(Object.prototype)
		expect(Object.hasOwn(Object.prototype, "fixture")).toBe(false)
	})
})
