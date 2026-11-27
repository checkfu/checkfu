export const DATA_HELPER_PATH = "_/data.js"

export const DATA_HELPER = `(() => {
	const root = new URL("data/", document.currentScript.src)
	const send = async (method, path, data, key) => {
		const sending = data === undefined ? {} : { "content-type": "application/json" }
		const response = await fetch(new URL(path, root), {
			method,
			headers: key === undefined ? sending : { ...sending, "idempotency-key": key },
			...(data === undefined ? {} : { body: JSON.stringify({ data }) }),
		})
		const body = await response.json().catch(() => null)
		if (response.ok) {
			return body
		}
		const error = new Error(body?.error?.message ?? "Request failed with status " + response.status)
		error.status = response.status
		throw error
	}
	const collection = (name) => {
		const at = encodeURIComponent(name)
		const one = (id) => at + "/" + encodeURIComponent(id)
		return {
			list: (options = {}) => {
				const query = new URLSearchParams()
				if (options.limit !== undefined) query.set("limit", String(options.limit))
				if (options.page !== undefined && options.page !== null) query.set("page", String(options.page))
				return send("GET", at + "?" + query)
			},
			get: (id) => send("GET", one(id)),
			add: (data, options = {}) => send("POST", at, data, options.key),
			put: (id, data) => send("PUT", one(id), data),
			delete: (id) => send("DELETE", one(id)),
		}
	}
	globalThis.artifactData = { collection }
})()
`
