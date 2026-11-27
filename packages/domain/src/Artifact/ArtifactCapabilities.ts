import { ArtifactCapabilities, MAX_ARTIFACT_CAPABILITIES_TEXT_LENGTH } from "@checkfu/sdk/Schemas"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

export { ArtifactCapabilities } from "@checkfu/sdk/Schemas"

export const CapabilitiesText = Schema.String.check(
	Schema.isMaxLength(MAX_ARTIFACT_CAPABILITIES_TEXT_LENGTH),
)

const capabilitiesJson = Schema.fromJsonString(ArtifactCapabilities)
const encode = Schema.encodeUnknownOption(capabilitiesJson)
const read = Schema.decodeOption(capabilitiesJson)
const fits = Schema.is(CapabilitiesText)

const NONE: ArtifactCapabilities = {}

const canonical = (capabilities: ArtifactCapabilities): ArtifactCapabilities => {
	const names = Object.keys(capabilities.database?.collections ?? {}).toSorted()
	return names.length === 0
		? NONE
		: {
				database: {
					collections: Object.fromEntries(
						names.flatMap((name) => {
							const collection = capabilities.database?.collections[name]
							return collection === undefined ? [] : [[name, collection]]
						}),
					),
				},
			}
}

export const encodeCapabilities = (capabilities: ArtifactCapabilities): string | undefined => {
	const ordered = canonical(capabilities)
	return ordered === NONE ? "" : Option.getOrUndefined(Option.filter(encode(ordered), fits))
}

export const decodeCapabilities = (text: string): ArtifactCapabilities =>
	text === "" ? NONE : Option.getOrElse(read(text), () => NONE)
