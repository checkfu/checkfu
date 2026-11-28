import { createHash } from "node:crypto"

export const STAGE_PATTERN = /^[a-z0-9]+[-_a-z0-9]*$/i

const maximumStageComponentLength = 255 - "stage-.json.000000000000.tmp".length

export const stagePathComponent = (stage: string): string => {
	const escaped = stage.replaceAll(/[A-Z]/g, (letter) => `~${letter.toLowerCase()}`)
	return escaped.length <= maximumStageComponentLength
		? escaped
		: `~~${createHash("sha256").update(stage).digest("hex")}`
}
