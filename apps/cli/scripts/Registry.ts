import { createHash } from "node:crypto"
import * as Schema from "effect/Schema"

const DIGEST = /^sha256:[a-f0-9]{64}$/
const Descriptor = Schema.Struct({
	digest: Schema.String.check(Schema.isPattern(DIGEST)),
	size: Schema.Finite,
})
const decodeManifest = Schema.decodeUnknownSync(
	Schema.Struct({
		mediaType: Schema.String,
		config: Descriptor,
		layers: Schema.Array(Descriptor),
	}),
)
const decodeIndex = Schema.decodeUnknownSync(
	Schema.Struct({
		manifests: Schema.Array(
			Schema.Struct({
				digest: Schema.String.check(Schema.isPattern(DIGEST)),
				platform: Schema.optionalKey(
					Schema.Struct({ os: Schema.String, architecture: Schema.String }),
				),
			}),
		),
	}),
)
const decodeToken = Schema.decodeUnknownSync(Schema.Struct({ token: Schema.String }))
const ACCEPT = [
	"application/vnd.oci.image.index.v1+json",
	"application/vnd.oci.image.manifest.v1+json",
	"application/vnd.docker.distribution.manifest.list.v2+json",
	"application/vnd.docker.distribution.manifest.v2+json",
].join(", ")
const digestOf = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`

const checked = async (response: Response, expected: ReadonlyArray<number>) => {
	if (!expected.includes(response.status)) {
		throw new Error(
			`Could not upload the sandbox image to Cloudflare (HTTP ${response.status}). Run checkfu deploy again to retry.`,
		)
	}
	return response
}

export interface RegistryTarget {
	readonly origin: string
	readonly repository: string
	readonly authorization: string
}

/** Registry HTTP API only: users never need a local Docker daemon. */
export const copySandboxImage = async (
	tag: string,
	target: RegistryTarget,
	request: typeof fetch = fetch,
	signal: AbortSignal = AbortSignal.timeout(15 * 60_000),
): Promise<string> => {
	const deadlineSignal = AbortSignal.any([signal, AbortSignal.timeout(15 * 60_000)])
	if (!/^sha256-[a-f0-9]{64}$/.test(tag)) {
		throw new Error("Invalid sandbox image version.")
	}
	const repository = "checkfu/sandbox"
	const tokenResponse = await request(
		`https://ghcr.io/token?service=ghcr.io&scope=repository:${repository}:pull`,
		{ signal: deadlineSignal },
	)
	if (!tokenResponse.ok) {
		throw new Error(
			`The Checkfu sandbox image is unavailable (HTTP ${tokenResponse.status}). No local Docker is required; retry later.`,
		)
	}
	const { token } = decodeToken(await tokenResponse.json())
	const source = async (path: string) => {
		const response = await request(`https://ghcr.io/v2/${repository}/${path}`, {
			signal: deadlineSignal,
			headers: { Authorization: `Bearer ${token}`, Accept: ACCEPT },
		})
		if (!response.ok) {
			throw new Error(`Could not download the Checkfu sandbox image (HTTP ${response.status}).`)
		}
		return response
	}
	let manifestResponse = await source(`manifests/${tag}`)
	let manifestBytes = new Uint8Array(await manifestResponse.arrayBuffer())
	if (/image.index|manifest.list/.test(manifestResponse.headers.get("content-type") ?? "")) {
		const index = decodeIndex(JSON.parse(new TextDecoder().decode(manifestBytes)))
		const linux = index.manifests.find(
			({ platform }) => platform?.os === "linux" && platform.architecture === "amd64",
		)
		if (linux === undefined) {
			throw new Error("Sandbox image has no Linux amd64 manifest.")
		}
		manifestResponse = await source(`manifests/${linux.digest}`)
		manifestBytes = new Uint8Array(await manifestResponse.arrayBuffer())
		if (digestOf(manifestBytes) !== linux.digest) {
			throw new Error("Sandbox image manifest failed its integrity check.")
		}
	}
	const manifestDigest = digestOf(manifestBytes)
	const manifest = decodeManifest(JSON.parse(new TextDecoder().decode(manifestBytes)))
	const destination = `${target.origin}/v2/${target.repository}`
	const push = (url: string, init: RequestInit) => {
		const headers = new Headers(init.headers)
		headers.set("Authorization", target.authorization)
		return request(url, {
			...init,
			signal: deadlineSignal,
			redirect: "manual",
			headers,
		})
	}
	const present = await push(`${destination}/manifests/${manifestDigest}`, { method: "HEAD" })
	if (present.status === 200) {
		return `${target.origin.replace(/^https:\/\//, "")}/${target.repository}@${manifestDigest}`
	}
	await checked(present, [404])
	for (const descriptor of [manifest.config, ...manifest.layers]) {
		if (
			!Number.isSafeInteger(descriptor.size) ||
			descriptor.size < 0 ||
			descriptor.size > 300 * 1024 * 1024
		) {
			throw new Error("Sandbox image layer exceeds the supported size.")
		}
		const exists = await push(`${destination}/blobs/${descriptor.digest}`, { method: "HEAD" })
		if (exists.status === 200) {
			continue
		}
		await checked(exists, [404])
		const blob = new Uint8Array(await (await source(`blobs/${descriptor.digest}`)).arrayBuffer())
		if (blob.length !== descriptor.size || digestOf(blob) !== descriptor.digest) {
			throw new Error(
				"Sandbox image layer failed its integrity check. Nothing unverified was uploaded.",
			)
		}
		const start = await checked(
			await push(`${destination}/blobs/uploads/`, { method: "POST" }),
			[202],
		)
		const location = start.headers.get("location")
		if (!location) {
			throw new Error("Cloudflare registry returned no upload location.")
		}
		const upload = new URL(location, target.origin)
		if (
			upload.origin !== new URL(target.origin).origin ||
			!upload.pathname.startsWith(`/v2/${target.repository}/blobs/uploads/`)
		) {
			throw new Error("Cloudflare registry returned an unsafe upload location.")
		}
		upload.searchParams.set("digest", descriptor.digest)
		await checked(
			await push(upload.href, {
				method: "PUT",
				headers: { "Content-Type": "application/octet-stream" },
				body: blob,
			}),
			[201],
		)
	}
	await checked(
		await push(`${destination}/manifests/${tag}`, {
			method: "PUT",
			headers: { "Content-Type": manifest.mediaType },
			body: manifestBytes,
		}),
		[201],
	)
	await checked(await push(`${destination}/manifests/${manifestDigest}`, { method: "HEAD" }), [200])
	return `${target.origin.replace(/^https:\/\//, "")}/${target.repository}@${manifestDigest}`
}
