import * as Config from "effect/Config"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

export const API_DOMAIN_ENV = "CHECKFU_API_DOMAIN"
export const MCP_DOMAIN_ENV = "CHECKFU_MCP_DOMAIN"

const UNSET = Schema.Literal("")

// A bare hostname such as api.example.com: no scheme, port or path.
export const Hostname = Schema.String.check(
	Schema.isMaxLength(253),
	Schema.isPattern(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/iu),
)

/** The Worker's `domain` setting, or nothing when the hostname is not configured. */
export const customDomain = (name: string): Config.Config<{ readonly domain?: string }> =>
	Config.option(Config.schema(Schema.Union([UNSET, Hostname]), name)).pipe(
		Config.map((value) =>
			Option.match(value, {
				onNone: () => ({}),
				onSome: (hostname) => (hostname === "" ? {} : { domain: hostname }),
			}),
		),
	)
