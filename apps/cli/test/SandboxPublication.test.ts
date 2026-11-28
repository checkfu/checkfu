import { expect, it, vi } from "vitest"
import { sandboxPublication } from "../scripts/Registry.ts"

const tag = `sha256-${"a".repeat(64)}`
const credentials = { user: "actor", token: "private-fixture" }
const manifest = (status: number, code?: string) =>
	Response.json(code === undefined ? {} : { errors: [{ code }] }, { status })
const present = () =>
	new Response("{}", { headers: { "content-type": "application/vnd.oci.image.index.v1+json" } })
const absent = () => manifest(404, "MANIFEST_UNKNOWN")
const repository = (tags: ReadonlyArray<string> = ["another-tag"]) =>
	Response.json({ name: "checkfu/sandbox", tags })
const says = (...responses: ReadonlyArray<Response>) => {
	const remaining = [Response.json({ token: "private-bearer" }), ...responses]
	return vi.fn<typeof fetch>(async () => {
		const next = remaining.shift()
		if (next === undefined) {
			throw new TypeError("unexpected request")
		}
		return next
	})
}

it("skips a present tag after a read-only authenticated probe", async () => {
	const fetcher = says(present())
	await expect(sandboxPublication(tag, credentials, fetcher)).resolves.toBe("present")
	expect(fetcher).toHaveBeenCalledTimes(2)
	expect(fetcher.mock.calls[0]).toEqual([
		expect.stringContaining("scope=repository%3Acheckfu%2Fsandbox%3Apull"),
		expect.objectContaining({
			redirect: "error",
			headers: expect.objectContaining({
				Authorization: `Basic ${Buffer.from("actor:private-fixture").toString("base64")}`,
			}),
		}),
	])
	expect(fetcher.mock.calls[1]).toEqual([
		`https://ghcr.io/v2/checkfu/sandbox/manifests/${tag}`,
		expect.objectContaining({
			redirect: "error",
			headers: expect.objectContaining({
				Authorization: "Bearer private-bearer",
				Accept: expect.stringContaining(
					"application/vnd.docker.distribution.manifest.list.v2+json",
				),
			}),
		}),
	])
})

it("permits publication only for a missing manifest in the accessible repository", async () => {
	const fetcher = says(absent(), repository())
	await expect(sandboxPublication(tag, credentials, fetcher)).resolves.toBe("missing")
	expect(fetcher.mock.calls[2]?.[0]).toBe("https://ghcr.io/v2/checkfu/sandbox/tags/list?n=1")
	await expect(
		sandboxPublication(tag, credentials, says(absent(), repository([tag]))),
	).resolves.toBe("present")
})

it.each([401, 403, 429, 500, 503, 304])(
	"refuses publication when the manifest returns %s",
	async (status) => {
		const fetcher = says(status === 304 ? new Response(null, { status }) : manifest(status))
		await expect(sandboxPublication(tag, credentials, fetcher)).rejects.toThrow(`HTTP ${status}`)
		expect(fetcher).toHaveBeenCalledTimes(2)
	},
)

it("refuses hidden repositories, non-manifest responses and invalid error documents", async () => {
	for (const response of [
		manifest(404, "NAME_UNKNOWN"),
		manifest(404),
		manifest(200),
		new Response("proxy error", { status: 404 }),
	]) {
		const fetcher = says(response)
		await expect(sandboxPublication(tag, credentials, fetcher)).rejects.toThrow()
		expect(fetcher).toHaveBeenCalledTimes(2)
	}
	await expect(sandboxPublication(tag, credentials, says(absent(), manifest(403)))).rejects.toThrow(
		"HTTP 403",
	)
	await expect(
		sandboxPublication(
			tag,
			credentials,
			says(absent(), Response.json({ name: "other/repo", tags: [] })),
		),
	).rejects.toThrow("wrong repository")
})

it("fails an unavailable inspection and allows a later run to skip without publishing", async () => {
	const failed = vi
		.fn<typeof fetch>()
		.mockResolvedValueOnce(Response.json({ token: "private-bearer" }))
		.mockRejectedValueOnce(new Error("authorization: private-bearer"))
	await expect(sandboxPublication(tag, credentials, failed)).rejects.toThrow("could not confirm")
	await expect(sandboxPublication(tag, credentials, says(present()))).resolves.toBe("present")
})
