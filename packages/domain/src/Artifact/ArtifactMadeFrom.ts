import * as Schema from "effect/Schema"
import { ArtifactId } from "./Artifact.id.ts"

export const MAX_MADE_FROM_TEXT_LENGTH = 64

export const MadeFromText = Schema.String.check(Schema.isMaxLength(MAX_MADE_FROM_TEXT_LENGTH))

export interface MadeFrom {
	readonly artifact_id: ArtifactId
	readonly version: number
}

const SEPARATOR = "@"
const isArtifactId = Schema.is(ArtifactId)

export const encodeMadeFrom = (source: MadeFrom): string =>
	`${source.artifact_id}${SEPARATOR}${source.version}`

export const decodeMadeFrom = (text: string): MadeFrom | null => {
	const [artifactId = "", version = "", ...rest] = text.split(SEPARATOR)
	const number = Number(version)
	return rest.length === 0 &&
		isArtifactId(artifactId) &&
		String(number) === version &&
		Number.isSafeInteger(number) &&
		number >= 1
		? { artifact_id: artifactId, version: number }
		: null
}
