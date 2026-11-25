import * as Config from "effect/Config"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

export const API_DOMAIN_ENV = "CHECKFU_API_DOMAIN"
export const MCP_DOMAIN_ENV = "CHECKFU_MCP_DOMAIN"
export const PUBLISH_DOMAIN_ENV = "CHECKFU_PUBLISH_DOMAIN"

export const DETACH_ALL = "none"

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

const PublishSetting = Schema.Union([Schema.Literal(""), Hostname])

const publishHostnameOf = (setting: typeof PublishSetting.Type | undefined) =>
	setting === undefined || setting === "" ? undefined : setting.toLowerCase()

export const publishDomain: Config.Config<string | undefined> = Config.option(
	Config.schema(PublishSetting, PUBLISH_DOMAIN_ENV),
).pipe(Config.map((setting) => publishHostnameOf(Option.getOrUndefined(setting))))

const Settings = Schema.Struct({
	[API_DOMAIN_ENV]: Schema.optionalKey(Setting),
	[MCP_DOMAIN_ENV]: Schema.optionalKey(Setting),
	[PUBLISH_DOMAIN_ENV]: Schema.optionalKey(PublishSetting),
}).check(
	Schema.makeFilter((settings) => {
		const api = hostnameOf(settings[API_DOMAIN_ENV])
		if (api !== undefined && api === hostnameOf(settings[MCP_DOMAIN_ENV])) {
			return {
				path: [MCP_DOMAIN_ENV],
				issue: `${API_DOMAIN_ENV} and ${MCP_DOMAIN_ENV} both name ${api}; a hostname can serve only one Worker`,
			}
		}
		const publish = publishHostnameOf(settings[PUBLISH_DOMAIN_ENV])
		const covered = ([API_DOMAIN_ENV, MCP_DOMAIN_ENV] as const).find((name) => {
			const hostname = hostnameOf(settings[name])
			return (
				publish !== undefined && hostname !== undefined && `.${hostname}`.endsWith(`.${publish}`)
			)
		})
		if (covered !== undefined) {
			return {
				path: [covered],
				issue: `${covered} is inside ${PUBLISH_DOMAIN_ENV} ${publish}, which serves published artifacts only; give them a domain of their own`,
			}
		}
		const implicit = ([API_DOMAIN_ENV, MCP_DOMAIN_ENV] as const).find(
			(name) => settings[name] === undefined || settings[name] === "",
		)
		return publish === undefined || implicit === undefined
			? undefined
			: {
					path: [implicit],
					issue: `${implicit} must be a hostname outside ${PUBLISH_DOMAIN_ENV} ${publish}, or ${DETACH_ALL}: left empty, hostnames already attached to the Worker stay, and one could be inside it`,
				}
	}),
)

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
