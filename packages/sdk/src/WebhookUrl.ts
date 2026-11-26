const IPV4_OCTETS = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
const HEX_IPV4_MAPPED = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i
const DECIMAL_IPV4_MAPPED = /^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i

const isDisallowedIpv4 = (a: number, b: number, c: number, d: number): boolean => {
	if ([a, b, c, d].some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
		return true
	}
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 0 && (c === 0 || c === 2)) ||
		(a === 192 && b === 168) ||
		(a === 198 && (b === 18 || b === 19)) ||
		(a === 198 && b === 51 && c === 100) ||
		(a === 203 && b === 0 && c === 113) ||
		a >= 224
	)
}

const isDisallowedHost = (hostname: string): boolean => {
	const lower = hostname.toLowerCase().replace(/\.+$/, "")
	if (lower.length === 0) {
		return true
	}
	if (
		lower === "localhost" ||
		lower.endsWith(".localhost") ||
		lower.endsWith(".local") ||
		lower.endsWith(".internal") ||
		lower.endsWith(".arpa")
	) {
		return true
	}
	if (lower.startsWith("[") && lower.endsWith("]")) {
		const inner = lower.slice(1, -1)
		const decMapped = DECIMAL_IPV4_MAPPED.exec(inner)
		if (decMapped !== null) {
			return isDisallowedIpv4(
				Number(decMapped[1]),
				Number(decMapped[2]),
				Number(decMapped[3]),
				Number(decMapped[4]),
			)
		}
		const hexMapped = HEX_IPV4_MAPPED.exec(inner)
		if (hexMapped !== null) {
			const hi = Number.parseInt(hexMapped[1] ?? "0", 16)
			const lo = Number.parseInt(hexMapped[2] ?? "0", 16)
			return isDisallowedIpv4((hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff)
		}
		const colon = inner.indexOf(":")
		if (colon <= 0) {
			return true
		}
		const firstHextet = Number.parseInt(inner.slice(0, colon), 16)
		if (Number.isNaN(firstHextet) || firstHextet < 0x20_00 || firstHextet > 0x3f_ff) {
			return true
		}
		if (inner.startsWith("2001:db8:") || inner.startsWith("2002:")) {
			return true
		}
		return false
	}
	const ipv4 = IPV4_OCTETS.exec(lower)
	if (ipv4 !== null) {
		return isDisallowedIpv4(Number(ipv4[1]), Number(ipv4[2]), Number(ipv4[3]), Number(ipv4[4]))
	}
	return !lower.includes(".")
}

/**
 * Validates and canonicalizes a webhook destination URL. Allows query parameters
 * while strictly refusing non-HTTPS schemes, embedded credentials, URL fragments,
 * single-label hosts, and private/loopback/link-local/CGNAT/multicast IP literals.
 */
export const parsePublicHttpsWebhookUrl = (raw: string): string | null => {
	const trimmed = raw.trim()
	if (trimmed.length < 8 || trimmed.length > 2048) {
		return null
	}
	if (trimmed.includes("#")) {
		return null
	}
	let parsed: URL
	try {
		parsed = new URL(trimmed)
	} catch {
		return null
	}
	if (
		parsed.protocol !== "https:" ||
		parsed.hostname.length === 0 ||
		parsed.username.length > 0 ||
		parsed.password.length > 0 ||
		parsed.hash.length > 0
	) {
		return null
	}
	if (isDisallowedHost(parsed.hostname)) {
		return null
	}
	return parsed.toString()
}

export const isPublicHttpsWebhookUrl = (raw: string): boolean =>
	parsePublicHttpsWebhookUrl(raw) !== null
