import type { RepositoryCheckout } from "@checkfu/domain/Session/SessionResource"
import { localDevBaseUrl } from "../Pi/PiModels.ts"

export const GITHUB_ORIGIN = "https://github.com"
export const GITHUB_BASE_URL_ENV = "CHECKFU_GITHUB_BASE_URL"

export const githubBaseUrl = localDevBaseUrl(GITHUB_BASE_URL_ENV)

export interface RepositoryMount {
	readonly id: string
	readonly url: string
	readonly mount_path: string
	readonly checkout: RepositoryCheckout | null
}

export type WorkspacePreparation =
	| { readonly ok: true }
	| { readonly ok: false; readonly resource_id: string; readonly message: string }

const NOT_MOUNTED = "Only the repositories mounted in this session can be reached."

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

/**
 * The only way git in a workspace reaches the network. A request goes through
 * when it is for a repository mounted in the session, carrying that
 * repository's token and no other credential. Redirects are returned, never
 * followed, so a token cannot be carried to another address.
 */
export const createRepositoryFetch =
	(options: {
		readonly repositories: () => ReadonlyArray<Pick<RepositoryMount, "id" | "url">>
		readonly token: (resourceId: string) => string | undefined
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
		const headers = new Headers(init?.headers)
		headers.delete("authorization")
		const token = options.token(repository.id)
		if (token !== undefined) {
			headers.set("authorization", `Basic ${btoa(`x-access-token:${token}`)}`)
		}
		return options.fetch(
			options.baseUrl === null ? href : `${options.baseUrl}${href.slice(GITHUB_ORIGIN.length)}`,
			{ ...init, headers, redirect: "manual" },
		)
	}
