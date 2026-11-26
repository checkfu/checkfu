import { normalizeAgentCreateBody } from "@checkfu/sdk/AgentInput"
import * as codec from "@checkfu/authoring/document"
import type { JsonAgent } from "@checkfu/sdk/client"
import { strFromU8, unzipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { bodyOf, changesFromSource, draftOf } from "../src/agent-draft.ts"
import { agentProjectArchive } from "../src/agent-export.ts"
import { readAgentSource } from "../src/agent-source.ts"

const agent: JsonAgent = {
	type: "agent",
	id: "agent_1",
	name: " Padded ",
	version: 3,
	model: { id: "fixture-model" },
	system: "  Exact instructions.\n\n",
	description: "",
	mcp_servers: [{ type: "url", name: "reports", url: "https://reports.example/mcp" }],
	tools: [{ type: "mcp_toolset", mcp_server_name: "reports" }],
	created_at: "2026-11-24T00:00:00Z",
	updated_at: "2026-11-24T00:00:00Z",
	archived_at: null,
}

describe("dashboard agent definitions", () => {
	it("reads Markdown frontmatter, JSON, and YAML with the same API validation", () => {
		expect(
			readAgentSource(codec, "---\nname: Support\nmodel: {id: fixture-model}\n---\n\nBe concise."),
		).toEqual({
			body: { name: "Support", model: { id: "fixture-model" }, system: "Be concise." },
		})
		const body = { name: "Support", model: "fixture-model" }
		expect(readAgentSource(codec, JSON.stringify(body))).toEqual({ body })
		expect(readAgentSource(codec, "name: Support\nmodel: fixture-model")).toEqual({ body })
		const invalid = readAgentSource(codec, "name: Support\nmodel: fixture-model\nversion: 4")
		expect(invalid.error).toContain("version")
		const ambiguous = readAgentSource(
			codec,
			"---\nname: Support\nmodel: fixture-model\nsystem: prompt\n---\nA second prompt",
		)
		expect(ambiguous.error).toContain("Markdown body")
	})

	it("uses the same submission body for Form and YAML retries", () => {
		const form = bodyOf(draftOf({ name: " Reporter ", model: " fixture-model " }))
		const source = codec.parseAgentDefinition(codec.agentDefinitionYaml(form))
		const identity = JSON.stringify(normalizeAgentCreateBody(form))
		expect(JSON.stringify(normalizeAgentCreateBody(source))).toBe(identity)
	})

	it("rejects YAML streams before a second definition can be lost", () => {
		const first = "name: First\nmodel: fixture-model\n"
		const second = "name: Second\nmodel: fixture-model\n"
		const reading = readAgentSource(codec, `${first}---\n${second}`)
		expect(reading.error).toContain("multiple documents")
		expect(() => codec.parseProjectDocument(`---\n${first}---\n${second}`, "mapping")).toThrow(
			"multiple documents",
		)
	})

	it("normalizes Markdown prose newlines and exports literal CRLF prompts in frontmatter", async () => {
		const markdown = "---\nname: Support\nmodel: fixture-model\n---\n\nFirst line.\nSecond line.\n"
		expect(codec.parseAgentDefinition(markdown.replaceAll("\n", "\r\n"))).toEqual(
			codec.parseAgentDefinition(markdown),
		)
		const exact = { ...agent, system: "First line.\r\nSecond line." }
		const { files, definitionFile } = await codec.agentProjectFiles(
			exact,
			"https://api.checkfu.test",
		)
		const exported = files[definitionFile]
		expect(exported).toContain("system:")
		expect(codec.parseAgentDefinition(exported ?? "").system).toBe(exact.system)
	})

	it("keeps the exact saved configuration and binds the archive to the API deployment", async () => {
		const source = codec.parseAgentDefinition(codec.agentDefinitionYaml(agent))
		expect(changesFromSource(agent, source)).toEqual({})
		expect(source).toMatchObject({ mcp_servers: agent.mcp_servers, tools: agent.tools })
		expect(changesFromSource(agent, { ...source, mcp_servers: [], tools: [] })).toEqual({
			mcp_servers: [],
			tools: [],
		})
		const archive = await agentProjectArchive(agent, "https://api.checkfu.test/")
		expect(archive.filename).toBe("padded.zip")
		const files = unzipSync(archive.contents)
		expect(Object.keys(files)).toEqual(["agents/padded.md", "checkfu-lock.json"])
		const definition = strFromU8(files["agents/padded.md"] ?? new Uint8Array())
		expect(definition).toContain("https://api.checkfu.test/schemas/apply/agent.json")
		expect(codec.parseAgentDefinition(definition)).toEqual(source)
		const lock = JSON.parse(strFromU8(files["checkfu-lock.json"] ?? new Uint8Array())) as unknown
		expect(lock).toMatchObject({
			version: 1,
			base_url: "https://api.checkfu.test",
			resources: {
				"./agents/padded.md": {
					kind: "agent",
					id: agent.id,
					hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
				},
			},
		})
	})
})
