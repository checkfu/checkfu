import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as IpNetwork from "effect/net/IpNetwork"
import * as NetAddress from "effect/net/NetAddress"

const reservedIpv4 = [
	"0.0.0.0/8",
	"10.0.0.0/8",
	"100.64.0.0/10",
	"127.0.0.0/8",
	"169.254.0.0/16",
	"172.16.0.0/12",
	"192.0.0.0/24",
	"192.0.2.0/24",
	"192.168.0.0/16",
	"198.18.0.0/15",
	"198.51.100.0/24",
	"203.0.113.0/24",
	"224.0.0.0/3",
].map(IpNetwork.fromStringUnsafe)

const ipv6GlobalUnicast = IpNetwork.fromStringUnsafe("2000::/3")
const reservedIpv6 = [
	"2001::/32",
	"2001:2::/48",
	"2001:10::/28",
	"2001:20::/28",
	"2001:db8::/32",
	"2002::/16",
].map(IpNetwork.fromStringUnsafe)

const isPublicAddress = (ip: NetAddress.IpAddress): boolean => {
	const address = NetAddress.isIpv6Address(ip)
		? Option.getOrElse(NetAddress.fromIpv4Mapped(ip), () => ip)
		: ip
	return NetAddress.isIpv4Address(address)
		? !reservedIpv4.some((range) => IpNetwork.contains(range, address))
		: IpNetwork.contains(ipv6GlobalUnicast, address) &&
				!reservedIpv6.some((range) => IpNetwork.contains(range, address))
}

/**
 * Returns true iff `ip` is a valid publicly-routable IPv4 or IPv6 address.
 * Accepts bracketed IPv6 literals (as produced by `URL.hostname`) and
 * evaluates IPv4-mapped IPv6 addresses against the IPv4 public-address rules.
 */
export const isPublicIpAddress = (ip: string): boolean => {
	const trimmed = ip.trim().toLowerCase()
	const bare = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed
	if (
		bare.includes("%") ||
		(bare.includes(":") && bare.includes(".") && !bare.startsWith("::ffff:"))
	) {
		return false
	}
	const parsed = NetAddress.ipFromString(bare)
	return Result.isSuccess(parsed) && isPublicAddress(parsed.success)
}

export const isLocalOrPrivateHost = (hostname: string): boolean => {
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
	const ipv4 = NetAddress.ipv4FromString(lower)
	if (Result.isSuccess(ipv4)) {
		return !isPublicAddress(ipv4.success)
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
	if (isLocalOrPrivateHost(parsed.hostname)) {
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
