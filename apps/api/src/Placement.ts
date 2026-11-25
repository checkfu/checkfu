import type * as Cloudflare from "@alchemy.run/cloudflare"
import * as Config from "effect/Config"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

export const JURISDICTION_ENV = "CHECKFU_JURISDICTION"
export const LOCATION_HINT_ENV = "CHECKFU_LOCATION_HINT"

const UNSET = Schema.Literal("")

// Placement.test.ts holds both lists equal to the platform's own types.
export const Jurisdiction = Schema.Literals(["eu", "fedramp", "fedramp-high", "us"])

export const LocationHint = Schema.Literals([
	"wnam",
	"enam",
	"sam",
	"weur",
	"eeur",
	"apac",
	"apac-ne",
	"apac-se",
	"oc",
	"afr",
	"me",
])

export interface Placement {
	readonly jurisdiction?: typeof Jurisdiction.Type
	readonly locationHint?: typeof LocationHint.Type
}

const setOrNone = <A extends string>(value: Option.Option<A | "">): Option.Option<A> =>
	Option.flatMap(value, (set) => (set === "" ? Option.none() : Option.some(set)))

export const placement: Config.Config<Placement> = Config.all({
	jurisdiction: Config.option(Config.schema(Schema.Union([UNSET, Jurisdiction]), JURISDICTION_ENV)),
	locationHint: Config.option(
		Config.schema(Schema.Union([UNSET, LocationHint]), LOCATION_HINT_ENV),
	),
}).pipe(
	Config.map(({ jurisdiction, locationHint }) => ({
		...Option.match(setOrNone(jurisdiction), {
			onNone: () => ({}),
			onSome: (set) => ({ jurisdiction: set }),
		}),
		...Option.match(setOrNone(locationHint), {
			onNone: () => ({}),
			onSome: (set) => ({ locationHint: set }),
		}),
	})),
)

// Names the jurisdiction in storage keys, so objects placed apart never share stored bytes.
export const DEFAULT_STORAGE_SCOPE = "default"

export const storageScopeOf = ({ jurisdiction }: Placement): string =>
	jurisdiction ?? DEFAULT_STORAGE_SCOPE

export const storageScope: Config.Config<string> = Config.map(placement, storageScopeOf)

export const placedStub =
	<Shape>(namespace: Cloudflare.DurableObject<Shape>, { jurisdiction, locationHint }: Placement) =>
	(name: string): Cloudflare.DurableObjectStub<Shape> => {
		const inside = jurisdiction === undefined ? namespace : namespace.jurisdiction(jurisdiction)
		return locationHint === undefined
			? inside.getByName(name)
			: inside.getByName(name, { locationHint })
	}
