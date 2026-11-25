export function timeAgo(iso: string, now = Date.now()): string {
	const s = Math.max(1, Math.round((now - new Date(iso).getTime()) / 1000))
	if (s < 60) {
		return "just now"
	}
	const m = Math.round(s / 60)
	if (m < 60) {
		return `${m}m ago`
	}
	const h = Math.round(m / 60)
	if (h < 48) {
		return `${h}h ago`
	}
	return `${Math.round(h / 24)}d ago`
}

export function shortId(id: string, tail = 7): string {
	const sep = id.indexOf("_")
	if (sep === -1 || id.length <= sep + 2 + tail) {
		return id
	}
	return `${id.slice(0, sep)}_…${id.slice(-tail)}`
}
