import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import {
	artifactSearch,
	byteSize,
	downloadUrl,
	expiry,
	fileView,
	previewable,
	publicationLabel,
	webUrl,
} from "../src/artifact-view.ts"
import { FileBody } from "../src/pages/artifacts.tsx"

const file = (content_type: string, encoding: "utf8" | "base64", content: string) => ({
	type: "artifact_file" as const,
	path: "index.html",
	sha256: "0".repeat(64),
	size: content.length,
	content_type,
	encoding,
	content,
})

describe("artifact file content", () => {
	it("shows text as text whatever its type, never as markup", () => {
		const page = file("text/html", "utf8", "<script>alert(1)</script><b>hi</b>")
		expect(fileView(page)).toEqual({ kind: "text", text: page.content })
		const html = renderToStaticMarkup(<FileBody file={page} />)
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;&lt;b&gt;hi&lt;/b&gt;")
		expect(html).not.toContain("<script")
		expect(fileView(file("image/svg+xml", "utf8", "<svg/>")).kind).toBe("text")
	})

	it("treats UTF-8 content holding a NUL byte as binary", () => {
		expect(fileView(file("application/octet-stream", "utf8", "\0\u0001\u0002"))).toEqual({
			kind: "binary",
		})
		expect(fileView(file("image/png", "utf8", "\0PNG"))).toEqual({ kind: "binary" })
	})

	it("builds a data URL only for known image types sent as base64", () => {
		expect(fileView(file("image/png", "base64", "iVBORw0K"))).toEqual({
			kind: "image",
			src: "data:image/png;base64,iVBORw0K",
		})
		expect(fileView(file(" Image/JPEG; charset=binary", "base64", "AAAA"))).toEqual({
			kind: "image",
			src: "data:image/jpeg;base64,AAAA",
		})
		for (const type of ["text/html", "application/pdf", "image/png,<x>", "image/unknown"]) {
			expect(fileView(file(type, "base64", "AAAA"))).toEqual({ kind: "binary" })
		}
		expect(
			renderToStaticMarkup(<FileBody file={file("application/zip", "base64", "AAAA")} />),
		).toContain("Binary file, 4 B.")
	})
})

describe("artifact labels", () => {
	it("names what a publication serves", () => {
		expect(publicationLabel(null)).toBeUndefined()
		expect(publicationLabel({ version: null })).toBe("Published · latest")
		expect(publicationLabel({ version: 3 })).toBe("Published · v3")
	})

	it("formats sizes", () => {
		expect(byteSize(0)).toBe("0 B")
		expect(byteSize(1023)).toBe("1023 B")
		expect(byteSize(1536)).toBe("1.5 KB")
		expect(byteSize(4 * 1024 * 1024)).toBe("4.0 MB")
		expect(byteSize(20 * 1024 * 1024)).toBe("20 MB")
	})

	it("says when a link expires", () => {
		const now = Date.parse("2026-11-24T00:00:00.000Z")
		expect(expiry("2026-11-24T00:10:00.000Z", now)).toBe("Expires in 10m")
		expect(expiry("2026-11-24T01:00:00.000Z", now)).toBe("Expires in 1h")
		expect(expiry("2026-12-01T00:00:00.000Z", now)).toBe("Expires in 7d")
		expect(expiry("2026-11-24T00:00:20.000Z", now)).toBe("Expires in under a minute")
		expect(expiry("2026-11-23T23:59:00.000Z", now)).toBe("Expired")
	})

	it("opens only web addresses", () => {
		expect(webUrl("https://example.com/p/a1-x/")).toBe("https://example.com/p/a1-x/")
		expect(webUrl("http://localhost:1339/l/abc")).toBe("http://localhost:1339/l/abc")
		expect(webUrl("javascript:alert(1)")).toBeUndefined()
		expect(webUrl("data:text/html,hi")).toBeUndefined()
		expect(webUrl("not a url")).toBeUndefined()
	})
})

describe("artifact page search", () => {
	it("keeps only a positive whole version and a non-empty path", () => {
		expect(artifactSearch({ version: 2, path: "a.txt" })).toEqual({ version: 2, path: "a.txt" })
		expect(artifactSearch({ version: 0, path: "" })).toEqual({})
		expect(artifactSearch({ version: 1.5 })).toEqual({})
		expect(artifactSearch({ version: "2", path: 3 })).toEqual({})
	})
})

describe("artifact file downloads", () => {
	it("previews a file only up to the size the JSON read returns", () => {
		expect(previewable({ size: 1024 * 1024 })).toBe(true)
		expect(previewable({ size: 1024 * 1024 + 1 })).toBe(false)
	})

	it("downloads raw bytes through the signed-in proxy", () => {
		expect(downloadUrl("art_1", 2, "data/a b.csv")).toBe(
			"/v1/artifacts/art_1/versions/2/content?file=data%2Fa%20b.csv",
		)
	})
})
