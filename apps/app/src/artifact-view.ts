const IMAGE_TYPES = new Set([
	"image/avif",
	"image/bmp",
	"image/gif",
	"image/jpeg",
	"image/png",
	"image/svg+xml",
	"image/vnd.microsoft.icon",
	"image/webp",
	"image/x-icon",
])

const UNITS = ["B", "KB", "MB", "GB"]

const mediaType = (contentType: string): string =>
	(contentType.split(";")[0] ?? "").trim().toLowerCase()

export type FileView =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "image"; readonly src: string }
	| { readonly kind: "binary" }

export const fileView = (file: {
	readonly content_type: string
	readonly encoding: "utf8" | "base64"
	readonly content: string
}): FileView => {
	if (file.encoding === "utf8") {
		return file.content.includes("\0") ? { kind: "binary" } : { kind: "text", text: file.content }
	}
	const type = mediaType(file.content_type)
	return IMAGE_TYPES.has(type)
		? { kind: "image", src: `data:${type};base64,${file.content}` }
		: { kind: "binary" }
}

export const publicationLabel = (
	publication: { readonly version: number | null } | null,
): string | undefined =>
	publication === null
		? undefined
		: `Published · ${publication.version === null ? "latest" : `v${publication.version}`}`

export const byteSize = (bytes: number): string => {
	let value = bytes
	let unit = 0
	while (value >= 1024 && unit < UNITS.length - 1) {
		value /= 1024
		unit++
	}
	const digits = unit === 0 || value >= 10 ? 0 : 1
	return `${value.toFixed(digits)} ${UNITS[unit]}`
}

export const webUrl = (url: string): string | undefined => {
	const parsed = URL.parse(url)
	return parsed !== null && (parsed.protocol === "https:" || parsed.protocol === "http:")
		? parsed.href
		: undefined
}

export const expiry = (iso: string, now = Date.now()): string => {
	const ms = new Date(iso).getTime() - now
	if (ms <= 0) {
		return "Expired"
	}
	const m = Math.round(ms / 60_000)
	if (m < 1) {
		return "Expires in under a minute"
	}
	if (m < 60) {
		return `Expires in ${m}m`
	}
	const h = Math.round(m / 60)
	return h < 48 ? `Expires in ${h}h` : `Expires in ${Math.round(h / 24)}d`
}

export interface ArtifactSearch {
	readonly version?: number
	readonly path?: string
}

export const artifactSearch = (search: {
	readonly version?: unknown
	readonly path?: unknown
}): ArtifactSearch => ({
	...(typeof search.version === "number" &&
	Number.isSafeInteger(search.version) &&
	search.version >= 1
		? { version: search.version }
		: {}),
	...(typeof search.path === "string" && search.path !== "" ? { path: search.path } : {}),
})
