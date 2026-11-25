import type { RepositoryMount } from "./WorkspaceShapes.ts"
import { localDevBaseUrl } from "../Pi/PiModels.ts"

export const GITHUB_ORIGIN = "https://github.com"
export const GITHUB_BASE_URL_ENV = "CHECKFU_GITHUB_BASE_URL"

export type { RepositoryMount, WorkspacePreparation } from "./WorkspaceShapes.ts"

export const githubBaseUrl = localDevBaseUrl(GITHUB_BASE_URL_ENV)

const NOT_MOUNTED = "Only the repositories mounted in this session can be reached."
const notAllowed = (host: string) =>
	`The session's environment does not let the workspace reach ${host}: add it to its networking's allowed_hosts.`

export const GIT_REQUEST_TIMEOUT_MS = 60_000

export const MAX_GIT_RESPONSE_BYTES = 8 * 1024 * 1024
const TOO_LARGE = `GitHub sent more than ${MAX_GIT_RESPONSE_BYTES / 1024 / 1024} MiB in one response, more than a workspace can take in one git transfer.`

const capped = (response: Response): Response => {
	if (response.body === null) {
		return response
	}
	let received = 0
	return new Response(
		response.body.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				transform: (chunk, controller) => {
					received += chunk.byteLength
					if (received > MAX_GIT_RESPONSE_BYTES) {
						controller.error(new Error(TOO_LARGE))
						return
					}
					controller.enqueue(chunk)
				},
			}),
		),
		response,
	)
}

const hrefOf = (input: Parameters<typeof fetch>[0]): string | null => {
	const raw = typeof input === "string" ? input : "href" in input ? input.href : null
	if (raw === null) {
		return null
	}
	try {
		return new URL(raw).href
	} catch {
		return null
	}
}

export const createRepositoryFetch =
	(options: {
		readonly repositories: () => ReadonlyArray<Pick<RepositoryMount, "id" | "url">>
		readonly token: (resourceId: string) => string | undefined
		readonly allowedHosts: () => ReadonlyArray<string> | null
		readonly baseUrl: string | null
		readonly fetch: typeof fetch
	}): typeof fetch =>
	async (input, init) => {
		const href = hrefOf(input)
		const repository =
			href === null
				? undefined
				: options
						.repositories()
						.find(({ url }) => href.startsWith(`${url}/`) || href.startsWith(`${url}.git/`))
		if (href === null || repository === undefined) {
			return new Response(NOT_MOUNTED, { status: 403 })
		}
		const host = new URL(href).hostname
		const allowed = options.allowedHosts()
		if (allowed !== null && !allowed.some((entry) => entry.toLowerCase() === host)) {
			return new Response(notAllowed(host), { status: 403 })
		}
		const headers = new Headers(init?.headers)
		headers.delete("authorization")
		const token = options.token(repository.id)
		if (token !== undefined) {
			headers.set("authorization", `Basic ${btoa(`x-access-token:${token}`)}`)
		}
		return capped(
			await options.fetch(
				options.baseUrl === null ? href : `${options.baseUrl}${href.slice(GITHUB_ORIGIN.length)}`,
				{
					...init,
					headers,
					redirect: "manual",
					signal: AbortSignal.any([
						AbortSignal.timeout(GIT_REQUEST_TIMEOUT_MS),
						...(init?.signal ? [init.signal] : []),
					]),
				},
			),
		)
	}
