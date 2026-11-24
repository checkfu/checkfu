import * as Config from "effect/Config"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

export const API_DOMAIN_ENV = "CHECKFU_API_DOMAIN"
export const MCP_DOMAIN_ENV = "CHECKFU_MCP_DOMAIN"

/** The value that removes every custom hostname from a Worker. */
export const DETACH_ALL = "none"

const UNSET = Schema.Literal("")

// A bare hostname such as api.example.com: no scheme, port or path. A single label is refused,
// so no hostname can be mistaken for `none`.
export const Hostname = Schema.String.check(
	Schema.isMaxLength(253),
	Schema.isPattern(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/iu),
)

/**
 * The Worker's `domain` setting, which Alchemy reads in three ways:
 *
 * - left out (variable unset or empty): hostnames already attached to the Worker are left as
 *   they are, whoever attached them;
 * - a hostname: it becomes the Worker's only custom hostname, and any other is detached;
 * - `null` (variable set to `none`): every custom hostname is detached.
 */
export const customDomain = (name: string): Config.Config<{ readonly domain?: string | null }> =>
	Config.option(
		Config.schema(Schema.Union([UNSET, Schema.Literal(DETACH_ALL), Hostname]), name),
	).pipe(
		Config.map((value) =>
			Option.match(value, {
				onNone: () => ({}),
				onSome: (set) =>
					set === "" ? {} : set === DETACH_ALL ? { domain: null } : { domain: set },
			}),
		),
	)
