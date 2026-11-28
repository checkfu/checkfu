import { CLIENT_EVENT_ID_MAX_LENGTH } from "@checkfu/sdk/IdempotencyKey"
import type { JsonSchema } from "effect/JsonSchema"
import { describe, expect, it } from "vitest"
import { MAX_ARTIFACT_DATA_LIMIT } from "../src/Workspace/SessionArtifactTool.ts"
import {
	ARTIFACT_DATA_TOOL,
	ARTIFACT_TOOL,
	BASH_TOOL,
	MAX_BASH_SECONDS,
} from "../src/Workspace/WorkspaceTools.ts"

describe("workspace tool parameters", () => {
	it("advertises the same argument names and bounds that the tools decode", () => {
		const nonempty = { type: "string", minLength: 1 }
		const artifactName = { ...nonempty, maxLength: 256 }
		const nullable = (schema: JsonSchema) => ({ anyOf: [schema, { type: "null" }] })
		expect(BASH_TOOL.parameters).toEqual({
			type: "object",
			properties: {
				command: nonempty,
				cwd: nonempty,
				timeout: { type: "integer", minimum: 1, maximum: MAX_BASH_SECONDS },
			},
			required: ["command"],
			additionalProperties: false,
		})
		expect(ARTIFACT_TOOL.parameters).toEqual({
			type: "object",
			properties: {
				name: artifactName,
				directory: nonempty,
				made_from: nullable({ type: "string" }),
			},
			required: ["name", "directory"],
			additionalProperties: false,
		})
		expect(ARTIFACT_DATA_TOOL.parameters).toEqual({
			type: "object",
			properties: {
				name: artifactName,
				collection: nonempty,
				operation: { type: "string", enum: ["list", "get", "add", "put", "delete"] },
				id: nullable(nonempty),
				data: {},
				key: { ...nonempty, maxLength: CLIENT_EVENT_ID_MAX_LENGTH },
				page: nullable(nonempty),
				limit: nullable({ type: "integer", minimum: 1, maximum: MAX_ARTIFACT_DATA_LIMIT }),
			},
			required: ["name", "collection", "operation"],
			additionalProperties: false,
		})
	})
})
