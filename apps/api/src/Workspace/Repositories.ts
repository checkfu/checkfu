import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as PubSub from "effect/PubSub"
import type { RepositoryMount } from "./WorkspaceShapes.ts"
import { localDevBaseUrl } from "../Pi/PiModels.ts"

export const GITHUB_ORIGIN = "https://github.com"
export const GITHUB_HOST = "github.com"
export const GITHUB_BASE_URL_ENV = "CHECKFU_GITHUB_BASE_URL"

export type { RepositoryMount, WorkspacePreparation } from "./WorkspaceShapes.ts"

export const githubBaseUrl = localDevBaseUrl(GITHUB_BASE_URL_ENV)

export const repositoryTokenGate = (hasToken: (id: string) => boolean) =>
	Effect.map(PubSub.unbounded<string>(), (tokens) => ({
		awaitToken: (id: string) =>
			Effect.gen(function* () {
				const stored = yield* PubSub.subscribe(tokens)
				if (!hasToken(id)) {
					yield* Effect.repeat(PubSub.take(stored), { until: (arrived) => arrived === id })
				}
			}).pipe(Effect.scoped, Effect.timeoutOption("30 seconds"), Effect.map(Option.isSome)),
		stored: (id: string) => PubSub.publish(tokens, id),
	}))

type Mounted = Pick<RepositoryMount, "id" | "url" | "access">

const GIT_SUFFIX = ".git"

export const repositoryOf = (href: string): string | undefined => {
	const url = URL.parse(href)
	if (url === null || url.origin !== GITHUB_ORIGIN) {
		return undefined
	}
	const [, owner, name] = url.pathname.split("/")
	if (!owner || !name) {
		return undefined
	}
	const repository = name.endsWith(GIT_SUFFIX) ? name.slice(0, -GIT_SUFFIX.length) : name
	return `${owner}/${repository}`.toLowerCase()
}

const isGitRead = (request: Request): boolean => {
	const url = new URL(request.url)
	const endpoint = url.pathname.split("/").slice(3).join("/")
	if (request.method === "POST") {
		return endpoint === "git-upload-pack" && !request.url.includes("?")
	}
	return (
		request.method === "GET" &&
		endpoint === "info/refs" &&
		url.search === "?service=git-upload-pack"
	)
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
		if (repository.access === "read_only" && !isGitRead(request)) {
			return Promise.resolve(
				new Response("This repository is mounted read-only.\n", { status: 403 }),
			)
		}
		const headers = new Headers(request.headers)
		const token = options.token(repository.id)
		if (token === undefined) {
			headers.delete("authorization")
		} else {
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
trap 'exit 143' TERM INT HUP
chmod 755 -- "$next"
if [ "$kind" = default ]; then
	git clone -q --depth 1 -- "$url" "$next"
else
	(
		cd "$next"
		git init -q
		git remote add origin "$url"
		if [ "$kind" = branch ]; then
			git fetch -q --depth 1 origin "+refs/heads/$ref:refs/remotes/origin/$ref"
			git checkout -q -b "$ref" --track "origin/$ref"
		else
			git fetch -q --depth 1 origin "$ref"
			git checkout -q --detach FETCH_HEAD
		fi
	)
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
