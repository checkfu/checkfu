import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { sandboxImageTag } from "../scripts/Image.ts"
import { copySandboxImage } from "../scripts/Registry.ts"

const bytes = (value: string) => new TextEncoder().encode(value)
const digest = (value: Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`
const tag = `sha256-${"a".repeat(64)}`
const target = {
	origin: "https://registry.cloudflare.com",
	repository: `${"a".repeat(32)}/checkfu-sandbox`,
	authorization: "Basic private_cloudflare_credential",
}
const directories: Array<string> = []
afterEach(async () => {
	for (const root of directories.splice(0)) {
		await rm(root, { recursive: true, force: true })
	}
})

const registry = (
	options: {
		readonly corrupt?: "short" | "same-length"
		readonly chunked?: boolean
		readonly emptyLayer?: boolean
		readonly unsafe?: boolean
		readonly unavailable?: boolean
	} = {},
) => {
	const blobs = [
		bytes('{"os":"linux","architecture":"amd64"}'),
		options.emptyLayer ? new Uint8Array() : bytes("sandbox tools layer"),
	]
	const manifest = bytes(
		JSON.stringify({
			mediaType: "application/vnd.oci.image.manifest.v1+json",
			config: { digest: digest(blobs[0]!), size: blobs[0]!.length },
			layers: [{ digest: digest(blobs[1]!), size: blobs[1]!.length }],
		}),
	)
	const stored = new Map<string, Uint8Array>()
	const calls: Array<{
		readonly url: string
		readonly method: string
		readonly auth: string | null
	}> = []
	const request: typeof fetch = async (input, init) => {
		const url = new URL(String(input))
		const method = init?.method ?? "GET"
		const auth = new Headers(init?.headers).get("Authorization")
		calls.push({ url: url.href, method, auth })
		if (url.host === "ghcr.io") {
			expect(auth ?? "").not.toContain("private_cloudflare_credential")
			if (url.pathname === "/token") {
				return Response.json(
					{ token: "public_pull_token" },
					{ status: options.unavailable ? 403 : 200 },
				)
			}
			if (url.pathname.endsWith(`/manifests/${tag}`)) {
				return Response.json(
					{
						manifests: [
							{ digest: digest(manifest), platform: { os: "linux", architecture: "amd64" } },
						],
					},
					{ headers: { "Content-Type": "application/vnd.oci.image.index.v1+json" } },
				)
			}
			if (url.pathname.endsWith(`/manifests/${digest(manifest)}`)) {
				return new Response(manifest, {
					headers: { "Content-Type": "application/vnd.oci.image.manifest.v1+json" },
				})
			}
			const found = blobs.find((blob) => url.pathname.endsWith(`/blobs/${digest(blob)}`))
			if (found) {
				if (options.corrupt === "short") {
					return new Response(found.slice(0, -1))
				}
				if (options.corrupt === "same-length") {
					return new Response(new Uint8Array(found.byteLength))
				}
				if (options.chunked && found.byteLength > 0) {
					return new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(found.subarray(0, 5))
								controller.enqueue(found.subarray(5))
								controller.close()
							},
						}),
					)
				}
				return new Response(found.byteLength === 0 ? null : found)
			}
			throw new Error(`Unexpected source request ${url}`)
		}
		expect(url.origin).toBe(target.origin)
		expect(auth).toBe(target.authorization)
		expect(init?.redirect).toBe("manual")
		if (method === "HEAD") {
			return new Response(null, { status: stored.has(url.pathname.split("/").at(-1)!) ? 200 : 404 })
		}
		if (method === "POST") {
			return new Response(null, {
				status: 202,
				headers: {
					Location: options.unsafe
						? "https://attacker.invalid/upload"
						: `/v2/${target.repository}/blobs/uploads/owned?state=keep`,
				},
			})
		}
		if (method === "PUT") {
			const body = new Uint8Array(await new Response(init?.body).arrayBuffer())
			if (url.pathname.includes("/blobs/uploads/")) {
				expect(url.searchParams.get("state")).toBe("keep")
				expect(digest(body)).toBe(url.searchParams.get("digest"))
			} else {
				expect(body).toEqual(manifest)
			}
			stored.set(digest(body), body)
			return new Response(null, { status: 201 })
		}
		throw new Error(`Unexpected destination request ${method} ${url}`)
	}
	return { request, calls, stored, manifest, blobs }
}

it("copies a verified Linux image over the registry protocol and reuses it without re-uploading", async () => {
	const r = registry({ chunked: true, emptyLayer: true })
	const image = await copySandboxImage(tag, target, r.request)
	expect(image).toBe(`registry.cloudflare.com/${target.repository}@${digest(r.manifest)}`)
	expect(r.stored.size).toBe(3)
	const writes = r.calls.filter(({ method }) => method === "PUT").length
	await expect(copySandboxImage(tag, target, r.request)).resolves.toBe(image)
	expect(r.calls.filter(({ method }) => method === "PUT")).toHaveLength(writes)
})

it("rejects corrupted blobs and unsafe upload locations before sending credentials or publishing a manifest", async () => {
	for (const [options, failure] of [
		[{ corrupt: "short" }, "integrity check"],
		[{ corrupt: "same-length" }, "integrity check"],
		[{ unsafe: true }, "unsafe upload location"],
		[{ unavailable: true }, "unavailable"],
	] as const) {
		const r = registry(options)
		await expect(copySandboxImage(tag, target, r.request)).rejects.toThrow(failure)
		expect(r.calls.some(({ method }) => method === "PUT")).toBe(false)
		expect(r.stored.size).toBe(0)
	}
})

it.each([
	{ part: "layer", limit: 0, error: "layer failed its integrity check" },
	{ part: "index", limit: 4 * 1024 * 1024, error: "manifest exceeds the supported size" },
	{ part: "manifest", limit: 4 * 1024 * 1024, error: "manifest exceeds the supported size" },
	{ part: "token", limit: 64 * 1024, error: "token exceeds the supported size" },
] as const)(
	"cancels an oversized $part without consuming its tail",
	async ({ part, limit, error }) => {
		const r = registry()
		const [config] = r.blobs
		if (config === undefined) {
			throw new Error("Expected an image config")
		}
		const suffix = {
			layer: `/blobs/${digest(config)}`,
			index: `/manifests/${tag}`,
			manifest: `/manifests/${digest(r.manifest)}`,
			token: "/token",
		}[part]
		const expected = part === "layer" ? config.byteLength : limit
		let pulls = 0
		let cancelled = false
		const body = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					pulls += 1
					controller.enqueue(new Uint8Array(pulls === 1 ? expected : 1))
					if (pulls === 3) {
						controller.close()
					}
				},
				cancel() {
					cancelled = true
				},
			},
			{ highWaterMark: 0 },
		)
		const request: typeof fetch = (input, init) => {
			const url = new URL(String(input))
			if (url.host === "ghcr.io" && url.pathname.endsWith(suffix)) {
				return Promise.resolve(new Response(body, { headers: { "content-length": "1" } }))
			}
			return r.request(input, init)
		}
		await expect(copySandboxImage(tag, target, request)).rejects.toThrow(error)
		expect(pulls).toBe(2)
		expect(cancelled).toBe(true)
		expect(body.locked).toBe(false)
		expect(r.calls.some(({ method }) => method === "POST" || method === "PUT")).toBe(false)
	},
)

it("propagates an interrupted blob transfer without starting an upload", async () => {
	const r = registry()
	const aborted = new AbortController()
	const reason = new Error("Transfer interrupted")
	const request: typeof fetch = (input, init) => {
		if (new URL(String(input)).pathname.includes("/blobs/sha256:") && init?.method !== "HEAD") {
			const signal = init?.signal
			return Promise.resolve(
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							signal?.addEventListener("abort", () => controller.error(signal.reason), {
								once: true,
							})
						},
						pull() {
							aborted.abort(reason)
						},
					}),
				),
			)
		}
		return r.request(input, init)
	}
	await expect(copySandboxImage(tag, target, request, aborted.signal)).rejects.toBe(reason)
	expect(r.calls.some(({ method }) => method === "POST" || method === "PUT")).toBe(false)
})

it("changes the image version when any build-context file changes, independently of the CLI version", async () => {
	const directory = await mkdtemp(join(tmpdir(), "checkfu-image-"))
	directories.push(directory)
	await writeFile(join(directory, "Dockerfile"), "FROM node:24-slim\n")
	const original = await sandboxImageTag(directory)
	await mkdir(join(directory, "tools"))
	await writeFile(join(directory, "tools", "hello.sh"), "echo hello\n")
	const extended = await sandboxImageTag(directory)
	expect(extended).not.toBe(original)
	await writeFile(join(directory, "tools", "hello.sh"), "echo changed\n")
	expect(await sandboxImageTag(directory)).not.toBe(extended)
})
