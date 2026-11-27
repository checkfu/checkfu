import { isLocalOrPrivateHost } from "@checkfu/sdk/WebhookUrl"

const notAllowed = (host: string) =>
	`The session's environment does not let the workspace reach ${host}: add it to its networking's allowed_hosts.`

export const PACKAGE_REGISTRY_HOSTS: ReadonlyArray<string> = [
	"registry.npmjs.org",
	"registry.yarnpkg.com",
	"pypi.org",
	"files.pythonhosted.org",
	"crates.io",
	"index.crates.io",
	"static.crates.io",
	"proxy.golang.org",
	"sum.golang.org",
	"rubygems.org",
	"index.rubygems.org",
	"repo.maven.apache.org",
	"repo1.maven.org",
	"deb.debian.org",
]

export interface MachineNetwork {
	readonly allowedHosts: () => ReadonlyArray<string> | null
	readonly fetch: (request: Request) => Promise<Response>
}

export const isAllowedHost = (allowed: ReadonlyArray<string> | null, host: string): boolean =>
	allowed === null || allowed.some((entry) => entry.toLowerCase() === host.toLowerCase())

export const createMachineEgress =
	(network: MachineNetwork) =>
	async (request: Request): Promise<Response> => {
		const { host, hostname } = new URL(request.url)
		const allowed = network.allowedHosts()
		if (!isAllowedHost(allowed, host)) {
			return new Response(notAllowed(host), { status: 403 })
		}
		if (allowed === null && isLocalOrPrivateHost(hostname)) {
			return new Response(
				`The workspace cannot reach ${host}: it is a local or private address. Add it to the environment's networking allowed_hosts to permit it.`,
				{ status: 403 },
			)
		}
		return network.fetch(new Request(request, { redirect: "manual" }))
	}
