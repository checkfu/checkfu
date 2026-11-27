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

export const encodeCapabilities = (capabilities: ArtifactCapabilities): string | undefined =>
	Object.keys(capabilities).length === 0
		? ""
		: Option.getOrUndefined(Option.filter(encode(capabilities), fits))

export const decodeCapabilities = (text: string): ArtifactCapabilities =>
	text === "" ? NONE : Option.getOrElse(read(text), () => NONE)
