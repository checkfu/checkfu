import type { RepositoryMount } from "./WorkspaceShapes.ts"
import { localDevBaseUrl } from "../Pi/PiModels.ts"

export const GITHUB_ORIGIN = "https://github.com"
export const GITHUB_HOST = "github.com"
export const GITHUB_BASE_URL_ENV = "CHECKFU_GITHUB_BASE_URL"

export type { RepositoryMount, WorkspacePreparation } from "./WorkspaceShapes.ts"

export const githubBaseUrl = localDevBaseUrl(GITHUB_BASE_URL_ENV)

type Mounted = Pick<RepositoryMount, "id" | "url">

const GIT_SUFFIX = ".git"

export const repositoryOf = (href: string): string | undefined => {
	const url = URL.parse(href)
	if (url === null || url.origin !== GITHUB_ORIGIN) {
		return undefined
	}
	const [owner, name] = url.pathname.split("/").slice(1)
	if (owner === undefined || owner === "" || name === undefined || name === "") {
		return undefined
	}
	const repository = name.endsWith(GIT_SUFFIX) ? name.slice(0, -GIT_SUFFIX.length) : name
	return `${owner}/${repository}`.toLowerCase()
}

export interface RepositoryCredentials {
	readonly repositories: () => ReadonlyArray<Mounted>
	readonly token: (resourceId: string) => string | undefined
	readonly baseUrl: string | null
	readonly fetch: (request: Request) => Promise<Response>
}

export const withRepositoryCredentials =
	(options: RepositoryCredentials) =>
	(request: Request): Promise<Response> => {
		const wanted = repositoryOf(request.url)
		const repository =
			wanted === undefined
				? undefined
				: options.repositories().find(({ url }) => repositoryOf(url) === wanted)
		if (repository === undefined) {
			return options.fetch(request)
		}
		const headers = new Headers(request.headers)
		headers.delete("authorization")
		const token = options.token(repository.id)
		if (token !== undefined) {
			headers.set("authorization", `Basic ${btoa(`x-access-token:${token}`)}`)
		}
		const target =
			options.baseUrl === null
				? request.url
				: `${options.baseUrl}${request.url.slice(GITHUB_ORIGIN.length)}`
		return options.fetch(new Request(target, new Request(request, { headers })))
	}

export const CLONE = `set -e
url=$1 dir=$2 kind=$3 ref=$4
if [ -e "$dir" ] || [ -L "$dir" ]; then
	exit 0
fi
parent=$(dirname -- "$dir")
mkdir -p -- "$parent"
next=$(mktemp -d "$parent/.clone-XXXXXX")
trap 'rm -rf -- "$next"' EXIT
chmod 755 -- "$next"
if [ "$kind" = default ]; then
	git clone --quiet --depth 1 -- "$url" "$next"
else
	git init --quiet -- "$next"
	git -C "$next" remote add origin "$url"
	if [ "$kind" = branch ]; then
		git -C "$next" fetch --quiet --depth 1 origin "+refs/heads/$ref:refs/remotes/origin/$ref"
		git -C "$next" checkout --quiet -b "$ref" --track "origin/$ref"
	else
		git -C "$next" fetch --quiet --depth 1 origin "$ref"
		git -C "$next" checkout --quiet --detach FETCH_HEAD
	fi
fi
mv -- "$next" "$dir"`

export const cloneCommand = (repository: RepositoryMount): ReadonlyArray<string> => {
	const { checkout } = repository
	const [kind, ref] =
		checkout === null
			? ["default", ""]
			: checkout.type === "branch"
				? ["branch", checkout.name]
				: ["commit", checkout.sha]
	return ["sh", "-c", CLONE, "sh", repository.url, repository.mount_path, kind, ref]
}
