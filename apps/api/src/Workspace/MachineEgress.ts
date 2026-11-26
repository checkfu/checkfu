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
	allowed === null || allowed.includes(host)

export const createMachineEgress =
	(network: MachineNetwork) =>
	async (request: Request): Promise<Response> => {
		const { host } = new URL(request.url)
		if (!isAllowedHost(network.allowedHosts(), host)) {
			return new Response(notAllowed(host), { status: 403 })
		}
		return network.fetch(new Request(request, { redirect: "manual" }))
	}
