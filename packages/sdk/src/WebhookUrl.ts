const IPV4_OCTETS = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
const HEX_IPV4_MAPPED = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i
const DECIMAL_IPV4_MAPPED = /^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i
const IPV6_HEXTET = /^[0-9a-f]{1,4}$/i

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

const parseIpv6Hextets = (raw: string): ReadonlyArray<number> | null => {
	if (raw.includes("%")) {
		return null
	}
	const parts = raw.split("::")
	if (parts.length > 2) {
		return null
	}
	const left = parts[0] === undefined || parts[0].length === 0 ? [] : parts[0].split(":")
	const right = parts[1] === undefined || parts[1].length === 0 ? [] : parts[1].split(":")
	const missing = parts.length === 2 ? 8 - (left.length + right.length) : 0
	if (parts.length === 1 && left.length !== 8) {
		return null
	}
	if (parts.length === 2 && missing < 1) {
		return null
	}
	const hextets: Array<number> = []
	for (const group of left) {
		if (!IPV6_HEXTET.test(group)) {
			return null
		}
		hextets.push(Number.parseInt(group, 16))
	}
	for (let i = 0; i < missing; i++) {
		hextets.push(0)
	}
	for (const group of right) {
		if (!IPV6_HEXTET.test(group)) {
			return null
		}
		hextets.push(Number.parseInt(group, 16))
	}
	return hextets.length === 8 ? hextets : null
}

/**
 * Returns true iff `ip` is a valid publicly-routable IPv4 or IPv6 address.
 * Accepts bracketed IPv6 literals (as produced by `URL.hostname`) and
 * evaluates IPv4-mapped IPv6 addresses against the IPv4 public-address rules.
 */
export const isPublicIpAddress = (ip: string): boolean => {
	const trimmed = ip.trim().toLowerCase()
	if (trimmed.length === 0) {
		return false
	}
	const unwrapped =
		trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed
	const ipv4 = IPV4_OCTETS.exec(unwrapped)
	if (ipv4 !== null) {
		return !isDisallowedIpv4(Number(ipv4[1]), Number(ipv4[2]), Number(ipv4[3]), Number(ipv4[4]))
	}
	if (!unwrapped.includes(":")) {
		return false
	}
	const decMapped = DECIMAL_IPV4_MAPPED.exec(unwrapped)
	if (decMapped !== null) {
		return !isDisallowedIpv4(
			Number(decMapped[1]),
			Number(decMapped[2]),
			Number(decMapped[3]),
			Number(decMapped[4]),
		)
	}
	const hexMapped = HEX_IPV4_MAPPED.exec(unwrapped)
	if (hexMapped !== null) {
		const hi = Number.parseInt(hexMapped[1] ?? "0", 16)
		const lo = Number.parseInt(hexMapped[2] ?? "0", 16)
		return !isDisallowedIpv4((hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff)
	}
	const hextets = parseIpv6Hextets(unwrapped)
	if (hextets === null) {
		return false
	}
	const [h0 = 0, h1 = 0, h2 = 0, h3 = 0, h4 = 0, h5 = 0, h6 = 0, h7 = 0] = hextets
	// Expanded IPv4-mapped IPv6 (::ffff:a.b.c.d)
	if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0xff_ff) {
		return !isDisallowedIpv4((h6 >> 8) & 0xff, h6 & 0xff, (h7 >> 8) & 0xff, h7 & 0xff)
	}
	// Only global unicast (2000::/3) is publicly routable.
	if (h0 < 0x20_00 || h0 > 0x3f_ff) {
		return false
	}
	// Reject Teredo (2001::/32), benchmarking (2001:2::/48), ORCHIDv2 (2001:20::/28),
	// documentation (2001:db8::/32), and 6to4 (2002::/16).
	if (h0 === 0x20_01) {
		if (
			h1 === 0x00_00 ||
			(h1 === 0x00_02 && h2 === 0x00_00) ||
			(h1 >= 0x00_10 && h1 <= 0x00_2f) ||
			h1 === 0x0d_b8
		) {
			return false
		}
	}
	if (h0 === 0x20_02) {
		return false
	}
	return true
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
		return !isPublicIpAddress(lower)
	}
	const ipv4 = IPV4_OCTETS.exec(lower)
	if (ipv4 !== null) {
		return !isPublicIpAddress(lower)
	}
	return !lower.includes(".")
}

/**
 * Validates and canonicalizes a webhook destination URL. Allows query parameters
 * while strictly refusing non-HTTPS schemes, embedded credentials, URL fragments,
 * single-label hosts, canonical URLs longer than 2048 bytes, and
 * private/loopback/link-local/CGNAT/multicast IP literals.
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
	const canonical = parsed.toString()
	if (canonical.length < 8 || canonical.length > 2048) {
		return null
	}
	return canonical
}

export const isPublicHttpsWebhookUrl = (raw: string): boolean =>
	parsePublicHttpsWebhookUrl(raw) !== null
