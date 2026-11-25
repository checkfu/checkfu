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

type Mounted = Pick<RepositoryMount, "id" | "url">

const mountedAt = (repositories: ReadonlyArray<Mounted>, href: string): Mounted | undefined =>
	repositories.find(({ url }) => href.startsWith(`${url}/`) || href.startsWith(`${url}.git/`))

const isAllowed = (allowed: ReadonlyArray<string> | null, host: string): boolean =>
	allowed === null || allowed.some((entry) => entry.toLowerCase() === host)

const withToken = (sent: HeadersInit | undefined, token: string | undefined): Headers => {
	const headers = new Headers(sent)
	headers.delete("authorization")
	if (token !== undefined) {
		headers.set("authorization", `Basic ${btoa(`x-access-token:${token}`)}`)
	}
	return headers
}

interface RepositoryAccess {
	readonly repositories: () => ReadonlyArray<Mounted>
	readonly token: (resourceId: string) => string | undefined
	readonly allowedHosts: () => ReadonlyArray<string> | null
	readonly baseUrl: string | null
	readonly fetch: typeof fetch
}

const addressOf = (baseUrl: string | null, href: string): string =>
	baseUrl === null ? href : `${baseUrl}${href.slice(GITHUB_ORIGIN.length)}`

export const makeGitCalls = () => {
	let current: AbortSignal | undefined
	let queue: Promise<unknown> = Promise.resolve()
	return {
		signal: (): AbortSignal | undefined => current,
		run: <A>(signal: AbortSignal, work: () => Promise<A>): Promise<A> => {
			const next = queue.then(async () => {
				signal.throwIfAborted()
				current = signal
				try {
					return await work()
				} finally {
					current = undefined
				}
			})
			queue = next.catch(() => undefined)
			return next
		},
	}
}

export const createRepositoryFetch =
	(options: RepositoryAccess & { readonly signal?: () => AbortSignal | undefined }): typeof fetch =>
	async (input, init) => {
		const call = options.signal?.()
		call?.throwIfAborted()
		const href =
			URL.parse(typeof input === "string" ? input : "href" in input ? input.href : "")?.href ?? null
		const repository = href === null ? undefined : mountedAt(options.repositories(), href)
		if (href === null || repository === undefined) {
			throw new Error(NOT_MOUNTED)
		}
		const host = new URL(href).hostname
		if (!isAllowed(options.allowedHosts(), host)) {
			throw new Error(notAllowed(host))
		}
		return capped(
			await options.fetch(addressOf(options.baseUrl, href), {
				...init,
				headers: withToken(init?.headers, options.token(repository.id)),
				redirect: "manual",
				signal: AbortSignal.any([
					AbortSignal.timeout(GIT_REQUEST_TIMEOUT_MS),
					...(init?.signal ? [init.signal] : []),
					...(call === undefined ? [] : [call]),
				]),
			}),
		)
	}

export const createMachineEgress =
	(options: RepositoryAccess) =>
	async (request: Request): Promise<Response> => {
		const { href, hostname } = new URL(request.url)
		if (!isAllowed(options.allowedHosts(), hostname)) {
			return new Response(notAllowed(hostname), { status: 403 })
		}
		const repository = mountedAt(options.repositories(), href)
		if (repository === undefined) {
			return options.fetch(new Request(request, { redirect: "manual" }))
		}
		return options.fetch(
			new Request(new Request(addressOf(options.baseUrl, href), request), {
				headers: withToken(request.headers, options.token(repository.id)),
				redirect: "manual",
			}),
		)
	}
