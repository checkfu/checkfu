import * as Config from "effect/Config"
import * as Schema from "effect/Schema"

export const API_DOMAIN_ENV = "CHECKFU_API_DOMAIN"
export const MCP_DOMAIN_ENV = "CHECKFU_MCP_DOMAIN"

/** The value that removes every custom hostname from a Worker. */
export const DETACH_ALL = "none"

// A bare ASCII hostname such as api.example.com: no scheme, port or path. A single label is
// refused, so no hostname can be mistaken for `none`. Letters are listed rather than matched
// case-insensitively, which would also accept characters such as "ſ" that a URL turns into
// ASCII letters; an international name is written in its xn-- form.
export const Hostname = Schema.String.check(
	Schema.isMaxLength(253),
	Schema.isPattern(
		/^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z][A-Za-z0-9-]{0,61}[A-Za-z0-9]$/,
	),
)

const Setting = Schema.Union([Schema.Literal(""), Schema.Literal(DETACH_ALL), Hostname])
type Setting = typeof Setting.Type

const hostnameOf = (setting: Setting | undefined) =>
	setting === undefined || setting === "" || setting === DETACH_ALL
		? undefined
		: setting.toLowerCase()

// Read together, so a hostname named for both Workers is refused before either is deployed.
// Cloudflare attaches a hostname to one Worker only, and Alchemy detaches a Worker's current
// hostnames before it finds out the new one belongs to the other Worker.
const Settings = Schema.Struct({
	[API_DOMAIN_ENV]: Schema.optionalKey(Setting),
	[MCP_DOMAIN_ENV]: Schema.optionalKey(Setting),
}).check(
	Schema.makeFilter((settings) => {
		const api = hostnameOf(settings[API_DOMAIN_ENV])
		return api !== undefined && api === hostnameOf(settings[MCP_DOMAIN_ENV])
			? {
					path: [MCP_DOMAIN_ENV],
					issue: `${API_DOMAIN_ENV} and ${MCP_DOMAIN_ENV} both name ${api}; a hostname can serve only one Worker`,
				}
			: undefined
	}),
)

/**
 * A Worker's `domain` setting, which Alchemy reads in three ways:
 *
 * - left out (variable unset or empty): hostnames already attached to the Worker are left as
 *   they are, whoever attached them;
 * - a hostname: it becomes the Worker's only custom hostname, and any other is detached;
 * - `null` (variable set to `none`): every custom hostname is detached.
 */
const toDomain = (setting: Setting | undefined): { readonly domain?: string | null } =>
	setting === undefined || setting === ""
		? {}
		: setting === DETACH_ALL
			? { domain: null }
			: { domain: setting }

export const customDomains = Config.schema(Settings).pipe(
	Config.map((settings) => ({
		api: toDomain(settings[API_DOMAIN_ENV]),
		mcp: toDomain(settings[MCP_DOMAIN_ENV]),
	})),
)
