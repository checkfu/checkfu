export const DATA_HELPER_PATH = "_/data.js"

export const DATA_HELPER = `(() => {
	const root = new URL("data/", document.currentScript.src)
	const hasId = (body) => typeof body?.id === "string" && body.id.length > 0
	const isDocument = (body) =>
		body?.type === "artifact_document" && hasId(body) && Object.hasOwn(body, "data")
	const isList = (body) =>
		Array.isArray(body?.data) && body.data.every(isDocument) &&
		(body.next_page === null || typeof body.next_page === "string")
	const isAdded = (body) =>
		isDocument(body) || (body?.type === "artifact_document_added" && hasId(body))
	const isDeleted = (body) => body?.type === "artifact_document_deleted" && hasId(body)
	const send = async (method, path, accepts, data, key) => {
		const sending = data === undefined ? {} : { "content-type": "application/json" }
		const response = await fetch(new URL(path, root), {
			method,
			headers: key === undefined ? sending : { ...sending, "idempotency-key": key },
			...(data === undefined ? {} : { body: JSON.stringify({ data }) }),
		})
		const body = await response.json().catch(() => null)
		if (response.ok && accepts(body)) {
			return body
		}
		const message = response.ok
			? "The Artifact data response could not be read." +
				(method === "GET" ? "" : " The change may already have been saved.")
			: body?.error?.message ?? "Request failed with status " + response.status
		const error = new Error(message)
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
				return send("GET", at + "?" + query, isList)
			},
			get: (id) => send("GET", one(id), isDocument),
			add: (data, options = {}) => send("POST", at, isAdded, data, options.key),
			put: (id, data) => send("PUT", one(id), isDocument, data),
			delete: (id) => send("DELETE", one(id), isDeleted),
		}
	}
	globalThis.artifactData = { collection }
})()
`
