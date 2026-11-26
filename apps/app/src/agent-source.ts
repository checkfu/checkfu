import type { CreateAgentBody } from "@checkfu/sdk/Api"

import type * as ProjectDocument from "@checkfu/authoring/document"

export type AgentSourceCodec = typeof ProjectDocument

export type AgentSourceReading =
	| { readonly body: CreateAgentBody; readonly error?: never }
	| { readonly body?: never; readonly error: string }

export const readAgentSource = (codec: AgentSourceCodec, text: string): AgentSourceReading => {
	try {
		return { body: codec.parseAgentDefinition(text) }
	} catch (error) {
		return { error: error instanceof Error ? error.message : "Could not read the definition." }
	}
}
