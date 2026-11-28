import { createHash } from "node:crypto"
import * as Data from "effect/Data"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import { readResponseBytes } from "../src/Deployment/ResponseBytes.ts"

const DIGEST = /^sha256:[a-f0-9]{64}$/
// The sandbox has one selected platform. Bound the index and image manifest independently.
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024
const MAX_TOKEN_BYTES = 64 * 1024
const MAX_LAYER_BYTES = 300 * 1024 * 1024
const LAYER_INTEGRITY_FAILURE =
	"Sandbox image layer failed its integrity check. Nothing unverified was uploaded."

const responseBytes = (response: Response, limit: number, tooLarge: string) =>
	response.body === null ? new Uint8Array() : readResponseBytes(response.body, limit, tooLarge)

const manifestBody = (response: Response) =>
	responseBytes(response, MAX_MANIFEST_BYTES, "Sandbox image manifest exceeds the supported size.")

const decodeJson = <A>(bytes: Uint8Array, decode: (value: unknown) => A): A =>
	decode(JSON.parse(new TextDecoder().decode(bytes)))
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
const ghcr = "https://ghcr.io"
const sandboxRepository = "checkfu/sandbox"
const validSandboxTag = /^sha256-[a-f0-9]{64}$/
const manifestTypes = new Set(ACCEPT.split(", "))
const decodeRegistryErrors = Schema.decodeUnknownSync(
	Schema.Struct({ errors: Schema.Array(Schema.Struct({ code: Schema.String })) }),
)
const decodeTagListing = Schema.decodeUnknownSync(
	Schema.Struct({ name: Schema.String, tags: Schema.NullOr(Schema.Array(Schema.String)) }),
)

class PublicationProbeFailure extends Data.TaggedError("PublicationProbeFailure")<{
	readonly message: string
}> {}

export const sandboxPublication = async (
	tag: string,
	credentials: { readonly user: string; readonly token: string },
	request: typeof fetch = fetch,
): Promise<"present" | "missing"> => {
	if (!validSandboxTag.test(tag) || credentials.user === "" || credentials.token === "") {
		throw new Error("The sandbox image version and registry credentials are required.")
	}
	const image = `ghcr.io/${sandboxRepository}:${tag}`
	const signal = AbortSignal.timeout(15_000)
	const get = (url: string, authorization: string) =>
		request(url, {
			signal,
			redirect: "error",
			headers: { Authorization: authorization, Accept: ACCEPT },
		})
	const tokenUrl = new URL("/token", ghcr)
	tokenUrl.searchParams.set("service", "ghcr.io")
	tokenUrl.searchParams.set("scope", `repository:${sandboxRepository}:pull`)
	try {
		const auth = Buffer.from(`${credentials.user}:${credentials.token}`).toString("base64")
		const tokenResponse = await get(tokenUrl.href, `Basic ${auth}`)
		if (tokenResponse.status !== 200) {
			throw new PublicationProbeFailure({
				message: `Registry authorization failed for ${image} (HTTP ${tokenResponse.status}).`,
			})
		}
		const { token } = decodeJson(
			await responseBytes(tokenResponse, MAX_TOKEN_BYTES, "Registry token response was too large."),
			decodeToken,
		)
		const repository = `${ghcr}/v2/${sandboxRepository}`
		const authorization = `Bearer ${token}`
		const manifest = await get(`${repository}/manifests/${tag}`, authorization)
		const contentType = manifest.headers.get("content-type")?.split(";")[0]?.trim()
		if (manifest.status === 200 && contentType !== undefined && manifestTypes.has(contentType)) {
			void manifest.body?.cancel().catch(() => undefined)
			return "present"
		}
		if (manifest.status !== 404) {
			void manifest.body?.cancel().catch(() => undefined)
			throw new PublicationProbeFailure({
				message: `Registry manifest status is unconfirmed for ${image} (HTTP ${manifest.status}).`,
			})
		}
		const { errors } = decodeJson(
			await responseBytes(manifest, MAX_TOKEN_BYTES, "Registry error response was too large."),
			decodeRegistryErrors,
		)
		if (errors.length !== 1 || errors[0]?.code !== "MANIFEST_UNKNOWN") {
			throw new PublicationProbeFailure({
				message: `Registry manifest status is unconfirmed for ${image} (HTTP 404).`,
			})
		}
		// A known repository distinguishes a missing tag from a hidden repository.
		const listing = await get(`${repository}/tags/list?n=1`, authorization)
		if (listing.status !== 200) {
			throw new PublicationProbeFailure({
				message: `Registry access to ${image} is unconfirmed (HTTP ${listing.status}).`,
			})
		}
		const { name, tags } = decodeJson(
			await responseBytes(listing, MAX_TOKEN_BYTES, "Registry tag response was too large."),
			decodeTagListing,
		)
		if (name !== sandboxRepository) {
			throw new PublicationProbeFailure({
				message: `Registry returned the wrong repository for ${image}.`,
			})
		}
		return tags?.includes(tag) === true ? "present" : "missing"
	} catch (error) {
		if (Predicate.isTagged("PublicationProbeFailure")(error)) {
			throw error
		}
		throw new Error(`Registry could not confirm the manifest for ${image}.`, { cause: error })
	}
}

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
	if (!validSandboxTag.test(tag)) {
		throw new Error("Invalid sandbox image version.")
	}
	const repository = sandboxRepository
	const tokenResponse = await request(
		`${ghcr}/token?service=ghcr.io&scope=repository:${repository}:pull`,
		{ signal: deadlineSignal },
	)
	if (!tokenResponse.ok) {
		throw new Error(
			`The Checkfu sandbox image is unavailable (HTTP ${tokenResponse.status}). No local Docker is required; retry later.`,
		)
	}
	const { token } = decodeJson(
		await responseBytes(
			tokenResponse,
			MAX_TOKEN_BYTES,
			"Sandbox registry token exceeds the supported size.",
		),
		decodeToken,
	)
	const source = async (path: string) => {
		const response = await request(`${ghcr}/v2/${repository}/${path}`, {
			signal: deadlineSignal,
			headers: { Authorization: `Bearer ${token}`, Accept: ACCEPT },
		})
		if (!response.ok) {
			throw new Error(`Could not download the Checkfu sandbox image (HTTP ${response.status}).`)
		}
		return response
	}
	let manifestResponse = await source(`manifests/${tag}`)
	let manifestBytes = await manifestBody(manifestResponse)
	if (/image.index|manifest.list/.test(manifestResponse.headers.get("content-type") ?? "")) {
		const index = decodeJson(manifestBytes, decodeIndex)
		const linux = index.manifests.find(
			({ platform }) => platform?.os === "linux" && platform.architecture === "amd64",
		)
		if (linux === undefined) {
			throw new Error("Sandbox image has no Linux amd64 manifest.")
		}
		manifestResponse = await source(`manifests/${linux.digest}`)
		manifestBytes = await manifestBody(manifestResponse)
		if (digestOf(manifestBytes) !== linux.digest) {
			throw new Error("Sandbox image manifest failed its integrity check.")
		}
	}
	const manifestDigest = digestOf(manifestBytes)
	const manifest = decodeJson(manifestBytes, decodeManifest)
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
			descriptor.size > MAX_LAYER_BYTES
		) {
			throw new Error("Sandbox image layer exceeds the supported size.")
		}
		const exists = await push(`${destination}/blobs/${descriptor.digest}`, { method: "HEAD" })
		if (exists.status === 200) {
			continue
		}
		await checked(exists, [404])
		const blob = await responseBytes(
			await source(`blobs/${descriptor.digest}`),
			descriptor.size,
			LAYER_INTEGRITY_FAILURE,
		)
		if (blob.length !== descriptor.size || digestOf(blob) !== descriptor.digest) {
			throw new Error(LAYER_INTEGRITY_FAILURE)
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
