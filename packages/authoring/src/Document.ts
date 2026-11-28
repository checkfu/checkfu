import * as Schema from "effect/Schema"
import * as YAML from "yaml"
import { CreateAgentBody, CreateAutomationBody } from "@checkfu/sdk/Api"
import type { JsonAutomation } from "@checkfu/sdk/client"
import { formatProjectLockfile, projectLockfileName } from "./Lockfile.ts"
import {
	agentProjectDefinition,
	automationProjectDefinition,
	canonicalProjectJson,
	maxProjectSourceBytes,
	savedAutomationDefinition,
} from "./Project.ts"

const markdownStart = /^---[ \t]*\r?\n/u
const frontmatter = /^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/mu
const jsonSchemaDialect = /^https?:\/\/json-schema\.org\/(?:[^/#]+\/)*schema(?:#.*)?$/u
const decodeMapping = Schema.decodeUnknownSync(Schema.JsonObject)
const decodeAgent = Schema.decodeUnknownSync(CreateAgentBody, { onExcessProperty: "error" })

const normalizeProse = (text: string): string =>
	text
		.replaceAll(/\r\n?/gu, "\n")
		.replace(/^(?:[ \t]*\n)+/u, "")
		.trimEnd()

export const parseProjectDocument = (text: string, format: "mapping" | "markdown" | "auto") => {
	if (
		text.length > maxProjectSourceBytes ||
		new TextEncoder().encode(text).byteLength > maxProjectSourceBytes
	) {
		throw new Error("Definition exceeds the 2 MiB limit.")
	}
	const raw = text.replace(/^\uFEFF/u, "")
	const header = format === "mapping" || !markdownStart.test(raw) ? null : frontmatter.exec(raw)
	const markdown = format === "markdown" || header !== null
	if (format === "markdown" && header === null && markdownStart.test(raw)) {
		throw new Error("Markdown frontmatter needs a closing --- line.")
	}
	const source = markdown ? (header?.[1] ?? "") : raw
	let mapping: Schema.JsonObject = {}
	if (source.trim() !== "") {
		const document = YAML.parseDocument(source, { logLevel: "error", stringKeys: true })
		const diagnostic = document.errors[0] ?? document.warnings[0]
		if (diagnostic !== undefined) {
			throw diagnostic
		}
		mapping = decodeMapping(document.toJS({ maxAliasCount: 0 }))
	}
	const { type, $schema, ...body } = mapping
	const prose = markdown ? normalizeProse(raw.slice(header?.[0].length ?? 0)) : ""
	const isJsonSchema = typeof $schema === "string" && jsonSchemaDialect.test($schema)
	return { type, body, prose, hasFrontmatter: header !== null, isJsonSchema }
}

export const fillProjectProse = (
	body: Schema.JsonObject,
	prose: string,
	field: "system" | "description" | "initial_events",
): Schema.JsonObject => {
	if (prose === "") {
		return body
	}
	if (Object.hasOwn(body, field)) {
		throw new Error(`Set ${field} in frontmatter or in the Markdown body.`)
	}
	const value =
		field === "initial_events"
			? [{ type: "user.message", content: [{ type: "text", text: prose }] }]
			: prose
	return Object.fromEntries([...Object.entries(body), [field, value]])
}

export const parseAgentDefinition = (text: string): CreateAgentBody => {
	const { type, body, prose } = parseProjectDocument(text, "auto")
	if (type !== undefined && type !== "agent") {
		throw new Error("Expected an agent definition.")
	}
	return decodeAgent(fillProjectProse(body, prose, "system"))
}

export const agentDefinitionYaml = ({
	name,
	model,
	description,
	system,
	mcp_servers,
	tools,
}: CreateAgentBody): string =>
	YAML.stringify(
		{
			name,
			model: typeof model === "string" ? model : model.id,
			...(description === undefined || description === null ? {} : { description }),
			...(system === undefined || system === null ? {} : { system }),
			...(mcp_servers?.length ? { mcp_servers } : {}),
			...(tools?.length ? { tools } : {}),
		},
		{ lineWidth: 0 },
	)

const agentDefinitionMarkdown = (body: CreateAgentBody): string => {
	const { system } = body
	if (
		system === undefined ||
		system === null ||
		system === "" ||
		normalizeProse(system) !== system
	) {
		return `---\n${agentDefinitionYaml(body)}---\n`
	}
	return `---\n${agentDefinitionYaml({ ...body, system: null })}---\n\n${system}\n`
}

const nameStem = (name: string, fallback: string): string =>
	name
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/gu, "-")
		.replaceAll(/^-|-$/gu, "")
		.slice(0, 80)
		.replace(/-$/u, "") || fallback

const projectFiles = async (
	id: string,
	kind: "agent" | "automation",
	stem: string,
	file: string,
	definition: unknown,
	baseUrl: string,
	text: string,
) => {
	const hash = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(canonicalProjectJson(definition)),
	)
	const lock = {
		version: 1 as const,
		base_url: baseUrl,
		resources: {
			[`./${file}`]: {
				kind,
				id,
				hash: Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join(
					"",
				),
			},
		},
	}
	return {
		stem,
		files: { [file]: text, [projectLockfileName]: formatProjectLockfile(lock) },
		definitionFile: file,
	}
}

export const agentProjectFiles = (
	agent: CreateAgentBody & { readonly id: string },
	baseUrl: string,
) => {
	const stem = nameStem(agent.name, "agent")
	const definition = agentProjectDefinition(agent)
	const apiUrl = baseUrl.replace(/\/+$/u, "")
	return projectFiles(
		agent.id,
		definition.kind,
		stem,
		`agents/${stem}.md`,
		definition,
		apiUrl,
		agentDefinitionMarkdown(definition.body).replace(
			"---\n",
			`---\n# yaml-language-server: $schema=${apiUrl}/schemas/apply/agent.json\n`,
		),
	)
}

const decodeAutomation = Schema.decodeUnknownSync(CreateAutomationBody, {
	onExcessProperty: "error",
})

export const automationProjectFiles = (automation: JsonAutomation, baseUrl: string) => {
	if (automation.archived_at !== null) {
		throw new Error("Archived automations cannot be exported.")
	}
	const definition = savedAutomationDefinition(automation)
	const stem = `${nameStem(automation.name, "automation")}--${automation.id}`
	const apiUrl = baseUrl.replace(/\/+$/u, "")
	const text = YAML.stringify({ type: definition.kind, ...definition.body }, { lineWidth: 0 })
	const parsed = parseProjectDocument(text, "mapping")
	if (
		canonicalProjectJson(automationProjectDefinition(decodeAutomation(parsed.body))) !==
		canonicalProjectJson(definition)
	) {
		throw new Error("The exported definition does not match the saved automation.")
	}
	return projectFiles(
		automation.id,
		definition.kind,
		stem,
		`automations/${stem}.yaml`,
		definition,
		apiUrl,
		`# yaml-language-server: $schema=${apiUrl}/schemas/apply/automation.json\n${text}`,
	)
}
