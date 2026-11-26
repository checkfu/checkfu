import { truncateText } from "@checkfu/domain/Session/TextBounds"
import { MAX_IDENTIFIER_LENGTH } from "@checkfu/sdk/Schemas"
import { toCodemodeIdentifier } from "@earendil-works/pi-codemode/declarations"

export const MODEL_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/u
const MAX_MODEL_NAME_LENGTH = 64

export const MAX_PUBLIC_TOOL_NAME_LENGTH = MAX_IDENTIFIER_LENGTH

const digest = (text: string): string => {
	let hash = 14_695_981_039_346_656_037n
	for (const byte of new TextEncoder().encode(text)) {
		hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 1_099_511_628_211n)
	}
	return hash.toString(36).padStart(13, "0").slice(0, 10)
}
const TAG_LENGTH = 10

export interface NamedTool {
	readonly prefix: string
	readonly name: string
}

export interface ToolNames extends NamedTool {
	readonly model: string
	readonly script: string
	readonly public: string
}

const sanitized = (text: string): string => text.replaceAll(/[^A-Za-z0-9_-]/gu, "_")

const fitsPublic = (name: string): boolean =>
	name.length > 0 && name.length <= MAX_PUBLIC_TOOL_NAME_LENGTH

const keyOf = (tool: NamedTool): string => JSON.stringify([tool.prefix, tool.name])

export const assignToolNames = (tools: ReadonlyArray<NamedTool>): ReadonlyArray<ToolNames> => {
	const distinct = [...new Map(tools.map((tool) => [keyOf(tool), tool])).entries()]
	const plain = new Map(
		distinct.map(([key, tool]) => {
			const name = `${tool.prefix}${tool.name}`
			return [key, MODEL_TOOL_NAME.test(name) ? name : undefined] as const
		}),
	)
	const sharing = new Map<string, number>()
	for (const name of plain.values()) {
		if (name !== undefined) {
			const script = toCodemodeIdentifier(name)
			sharing.set(script, (sharing.get(script) ?? 0) + 1)
		}
	}
	const models = new Map<string, string>()
	const takenModels = new Set<string>()
	const takenScripts = new Set<string>()
	const take = (key: string, model: string): void => {
		models.set(key, model)
		takenModels.add(model)
		takenScripts.add(toCodemodeIdentifier(model))
	}
	for (const [key, name] of plain) {
		if (name !== undefined && sharing.get(toCodemodeIdentifier(name)) === 1) {
			take(key, name)
		}
	}
	const sorted = distinct.toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
	for (const [key, tool] of sorted) {
		if (models.has(key)) {
			continue
		}
		const prefix = sanitized(tool.prefix).slice(0, MAX_MODEL_NAME_LENGTH - TAG_LENGTH)
		const head = sanitized(tool.name).slice(
			0,
			MAX_MODEL_NAME_LENGTH - prefix.length - TAG_LENGTH - 1,
		)
		for (let salt = 0; ; salt += 1) {
			const tag = digest(salt === 0 ? key : `${key}#${salt}`)
			const model = `${prefix}${head.length === 0 ? "" : `${head}_`}${tag}`
			if (!takenModels.has(model) && !takenScripts.has(toCodemodeIdentifier(model))) {
				take(key, model)
				break
			}
		}
	}
	const publics = new Map<string, string>()
	const takenPublics = new Set<string>()
	for (const [key, tool] of distinct) {
		if (fitsPublic(tool.name)) {
			publics.set(key, tool.name)
			takenPublics.add(JSON.stringify([tool.prefix, tool.name]))
		}
	}
	for (const [key, tool] of sorted) {
		if (publics.has(key)) {
			continue
		}
		const head = truncateText(tool.name, MAX_PUBLIC_TOOL_NAME_LENGTH - TAG_LENGTH - 1)
		for (let salt = 0; ; salt += 1) {
			const tag = digest(salt === 0 ? key : `${key}#${salt}`)
			const name = `${head.length === 0 ? "" : `${head}_`}${tag}`
			const taken = JSON.stringify([tool.prefix, name])
			if (!takenPublics.has(taken)) {
				publics.set(key, name)
				takenPublics.add(taken)
				break
			}
		}
	}
	return distinct.map(([key, tool]) => {
		const model = models.get(key) ?? ""
		return {
			prefix: tool.prefix,
			name: tool.name,
			model,
			script: toCodemodeIdentifier(model),
			public: publics.get(key) ?? "",
		}
	})
}
