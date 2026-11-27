import type { JsonValue } from "@earendil-works/chord/json"
import { boundOutput, utf8ByteLength } from "@earendil-works/chord/output"
import type { OutputLimits } from "@earendil-works/chord/output"
import { ToolTask, defineExtension, hook } from "@earendil-works/pi-durable"
import type { ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable"

export const STORAGE_ROW_BYTES = 2_000_000

const PI_TEXT_BYTES = 50 * 1024

export const PI_DEFAULT_LIMITS: OutputLimits = {
	maxBytes: PI_TEXT_BYTES,
	maxLines: 2000,
	retain: "head",
}

export const outputLimitsOf = (tool: Pick<ToolRegistration, "outputLimits">): OutputLimits => ({
	maxBytes: tool.outputLimits?.maxBytes ?? PI_DEFAULT_LIMITS.maxBytes,
	maxLines: tool.outputLimits?.maxLines ?? PI_DEFAULT_LIMITS.maxLines,
	retain: tool.outputLimits?.retain ?? PI_DEFAULT_LIMITS.retain,
})

const ENTRY_RESERVE_BYTES = 64 * 1024

export const DIAGNOSTIC_BUDGET_BYTES = PI_TEXT_BYTES

export const MAX_RESULT_DIAGNOSTICS = 64

const RENDER_FRAME_BYTES = 64

const DIAGNOSTIC_RESERVE_BYTES = 2 * DIAGNOSTIC_BUDGET_BYTES + RENDER_FRAME_BYTES

const FRAME_RESERVE_BYTES = 4 * 1024

export const RESULT_BUDGET_BYTES =
	STORAGE_ROW_BYTES - DIAGNOSTIC_RESERVE_BYTES - FRAME_RESERVE_BYTES - ENTRY_RESERVE_BYTES

type Stored = Pick<
	ToolExecutionResult,
	"output" | "details" | "diagnostics" | "isError" | "usage" | "structuredOutput"
>
type Output = NonNullable<ToolExecutionResult["output"]>
type Item = Output[number]
type Diagnostics = NonNullable<ToolExecutionResult["diagnostics"]>
type Diagnostic = Diagnostics[number]

export const serializedBytes = (value: unknown): number =>
	value === undefined ? 0 : utf8ByteLength(JSON.stringify(value))

const imageBytes = (output: Output): number =>
	output.reduce((sum, item) => (item.type === "image" ? sum + serializedBytes(item) + 1 : sum), 0)

const isObject = (value: JsonValue): value is Readonly<Record<string, JsonValue>> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const DETAILS_CUT: JsonValue = { truncated: true }

export const boundResultDetails = (
	details: JsonValue | undefined,
	room: number,
): JsonValue | undefined => {
	if (details === undefined || serializedBytes(details) <= room) {
		return details
	}
	if (isObject(details) && Array.isArray(details["calls"])) {
		const calls = details["calls"]
		const frame = { ...details, calls: [] as Array<JsonValue>, omitted_calls: calls.length }
		let left = room - serializedBytes(frame)
		const kept: Array<JsonValue> = []
		for (const call of calls) {
			const size = serializedBytes(call) + 1
			if (size > left) {
				break
			}
			kept.push(call)
			left -= size
		}
		const trimmed = { ...details, calls: kept, omitted_calls: calls.length - kept.length }
		if (serializedBytes(trimmed) <= room) {
			return trimmed
		}
	}
	return DETAILS_CUT
}

const imageNote = (item: Extract<Item, { type: "image" }>, bytes: number): Item => ({
	type: "text",
	text: `[${item.mimeType} image of ${bytes} bytes left out: a tool result keeps at most ${RESULT_BUDGET_BYTES} bytes of images and details. Ask for a smaller one.]`,
})

export const boundResultImages = (output: Output, room: number): Output => {
	let left = room
	let changed = false
	const bounded = output.map((item) => {
		if (item.type !== "image") {
			return item
		}
		const bytes = serializedBytes(item) + 1
		if (bytes <= left) {
			left -= bytes
			return item
		}
		changed = true
		return imageNote(item, bytes)
	})
	return changed ? bounded : output
}

const headWithin = (text: string, room: number): string => {
	let low = 0
	let high = Math.min(text.length, Math.max(0, room))
	while (low < high) {
		const middle = Math.ceil((low + high) / 2)
		if (serializedBytes(text.slice(0, middle)) <= room) {
			low = middle
		} else {
			high = middle - 1
		}
	}
	const head = text.slice(0, low)
	return head.isWellFormed() ? head : head.slice(0, -1)
}

const tailWithin = (text: string, room: number): string => {
	let low = 0
	let high = Math.min(text.length, Math.max(0, room))
	while (low < high) {
		const middle = Math.ceil((low + high) / 2)
		if (serializedBytes(text.slice(text.length - middle)) <= room) {
			low = middle
		} else {
			high = middle - 1
		}
	}
	const tail = low === 0 ? "" : text.slice(text.length - low)
	return tail.isWellFormed() ? tail : tail.slice(1)
}

const diagnosticsCut = (cut: number, omitted: number): Diagnostic => ({
	severity: "warn",
	code: "truncated",
	message: `Diagnostics truncated: ${cut} cut short, ${omitted} left out. A tool result keeps at most ${DIAGNOSTIC_BUDGET_BYTES} bytes of them.`,
})

const CUT_NOTE_BYTES = serializedBytes(diagnosticsCut(1, Number.MAX_SAFE_INTEGER)) + 1

export const boundResultDiagnostics = (
	diagnostics: Diagnostics | undefined,
	room: number,
): Diagnostics | undefined => {
	if (
		diagnostics === undefined ||
		(diagnostics.length <= MAX_RESULT_DIAGNOSTICS && serializedBytes(diagnostics) <= room)
	) {
		return diagnostics
	}
	let left = room - 2 - CUT_NOTE_BYTES
	const kept: Array<Diagnostic> = []
	let cut = 0
	for (const diagnostic of diagnostics) {
		if (kept.length === MAX_RESULT_DIAGNOSTICS - 1) {
			break
		}
		const size = serializedBytes(diagnostic) + 1
		if (size <= left) {
			kept.push(diagnostic)
			left -= size
			continue
		}
		const frame = serializedBytes({ ...diagnostic, message: "" }) + 1
		const message = headWithin(diagnostic.message, left - frame)
		if (message !== "") {
			kept.push({ ...diagnostic, message })
			cut = 1
		}
		break
	}
	return [...kept, diagnosticsCut(cut, diagnostics.length - kept.length)]
}

export const coalesceResultText = (output: Output): Output => {
	const merged: Array<Item> = []
	let changed = false
	for (const item of output) {
		const last = merged.at(-1)
		if (item.type === "text" && last?.type === "text") {
			merged[merged.length - 1] = { type: "text", text: last.text + item.text }
			changed = true
		} else if (item.type === "text" && item.textSignature !== undefined) {
			merged.push({ type: "text", text: item.text })
			changed = true
		} else {
			merged.push(item)
		}
	}
	return changed ? merged : output
}

const renderedDiagnostics = (diagnostics: Diagnostics): string =>
	`<harness>\n${diagnostics.map((each) => `[${each.severity}] ${each.message}`).join("\n")}\n</harness>`

const isText = (item: Item) => item.type === "text"

const keptByPi = (output: Output, limits: OutputLimits) => {
	const texts = output.flatMap((item) => (item.type === "text" ? [item.text] : []))
	const bounded = boundOutput(texts.join(""), limits)
	if (bounded.droppedBytes === 0) {
		return { content: output, cut: undefined }
	}
	const keep = limits.retain === "head" ? output.findIndex(isText) : output.findLastIndex(isText)
	return {
		content: output.flatMap((item, index): Array<Item> =>
			item.type !== "text" ? [item] : index === keep ? [{ ...item, text: bounded.text }] : [],
		),
		cut: {
			severity: "warn" as const,
			code: "truncated",
			message: `Output truncated to its ${limits.retain === "head" ? "beginning" : "end"}: ${bounded.droppedLines} lines, ${bounded.droppedBytes} bytes dropped`,
		},
	}
}

export interface CalledAs {
	readonly id: string
	readonly name: string
}

const UNNAMED: CalledAs = { id: "", name: "" }

const rowBytes = (result: Stored, limits: OutputLimits, call: CalledAs): number => {
	const { content, cut } = keptByPi(result.output ?? [], limits)
	const diagnostics = [...(result.diagnostics ?? []), ...(cut === undefined ? [] : [cut])]
	const rendered: Array<unknown> = [...content]
	if (diagnostics.length > 0) {
		rendered.push({ type: "text", text: renderedDiagnostics(diagnostics) })
	}
	return (
		serializedBytes({
			model: [
				{
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.name,
					content: rendered,
					details: result.details,
					usage: result.usage,
					isError: result.isError ?? false,
					durationMs: Number.MAX_SAFE_INTEGER,
					timestamp: Number.MAX_SAFE_INTEGER,
				},
			],
			data: { diagnostics },
		}) + ENTRY_RESERVE_BYTES
	)
}

export const storedRowBytes = (
	result: Stored,
	limits: ReadonlyArray<OutputLimits> = [PI_DEFAULT_LIMITS],
	call: CalledAs = UNNAMED,
): number => Math.max(...limits.map((each) => rowBytes(result, each, call)))

export type NestedForm = "structured" | "value"

export interface Nested {
	readonly forms: ReadonlyArray<NestedForm>
}

export const nestedFormsOf = (
	registrations: ReadonlyArray<Pick<ToolRegistration, "structuredOutputSchema">>,
): Nested => ({
	forms: [
		...(registrations.length === 0 ||
		registrations.some((each) => each.structuredOutputSchema === undefined)
			? (["value"] as const)
			: []),
		...(registrations.some((each) => each.structuredOutputSchema !== undefined)
			? (["structured"] as const)
			: []),
	],
})

const valueOfOutput = (output: Output) => {
	const [only] = output
	if (only === undefined) {
		return ""
	}
	return output.length > 1 ? output : only.type === "text" ? only.text : only
}

const toolErrorOf = (result: Stored, content: Output): ReadonlyArray<Diagnostic> => {
	if (
		result.isError !== true ||
		result.structuredOutput !== undefined ||
		(result.diagnostics ?? []).some((each) => each.severity === "error")
	) {
		return []
	}
	const text = content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n")
	return text === "" ? [] : [{ severity: "error", code: "tool_error", message: text }]
}

const nestedRowBytes = (result: Stored, limits: OutputLimits, form: NestedForm): number => {
	const { content, cut } = keptByPi(result.output ?? [], limits)
	const diagnostics = [
		...(result.diagnostics ?? []),
		...(cut === undefined ? [] : [cut]),
		...(form === "structured" ? toolErrorOf(result, content) : []),
	]
	return (
		serializedBytes({
			kind: "nested",
			taskId: Number.MAX_SAFE_INTEGER,
			result: {
				taskId: Number.MAX_SAFE_INTEGER,
				structuredOutput: form === "structured" ? result.structuredOutput : valueOfOutput(content),
				isError: result.isError ?? false,
				details: result.details,
				diagnostics,
				usage: result.usage,
				durationMs: Number.MAX_SAFE_INTEGER,
			},
		}) + ENTRY_RESERVE_BYTES
	)
}

export const storedNestedBytes = (
	result: Stored,
	nested: Nested,
	limits: ReadonlyArray<OutputLimits> = [PI_DEFAULT_LIMITS],
): number =>
	Math.max(
		...limits.flatMap((each) => nested.forms.map((form) => nestedRowBytes(result, each, form))),
	)

const imagesCut = (left: number): Diagnostic => ({
	severity: "warn",
	code: "truncated",
	message: `Output truncated: ${left} images left out. A tool result keeps at most ${RESULT_BUDGET_BYTES} bytes of images and details.`,
})

const IMAGES_CUT_RESERVE_BYTES = 2 * serializedBytes(imagesCut(Number.MAX_SAFE_INTEGER)) + 16

const textOf = (output: Output): string =>
	output.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("")

const separate = (
	output: Output | undefined,
	limits: ReadonlyArray<OutputLimits>,
): Output | undefined => {
	const texts = output?.filter((item) => item.type === "text") ?? []
	if (output === undefined || new Set(texts).size === texts.length) {
		return output
	}
	const text = textOf(output)
	return limits.some((each) => boundOutput(text, each).droppedBytes > 0)
		? output.map((item) => (item.type === "text" ? { ...item } : item))
		: output
}

const shortened = (dropped: number, retain: OutputLimits["retain"]): Diagnostic => ({
	severity: "warn",
	code: "truncated",
	message: `Output truncated to its ${retain === "tail" ? "end" : "beginning"}: ${dropped} characters dropped, so the result fits what a session keeps of one.`,
})

const shorten = <R extends Stored>(
	result: R,
	limits: ReadonlyArray<OutputLimits>,
	measure: (result: R) => number,
): R => {
	const output = result.output ?? []
	const text = textOf(output)
	const retain = limits.some((each) => each.retain === "tail") ? "tail" : "head"
	const keep = retain === "tail" ? output.findLastIndex(isText) : output.findIndex(isText)
	const within = (kept: string): R => ({
		...result,
		output: output.flatMap((item, index): Array<Item> =>
			item.type !== "text" ? [item] : index === keep ? [{ type: "text", text: kept }] : [],
		),
		diagnostics: boundResultDiagnostics(
			[shortened(text.length - kept.length, retain), ...(result.diagnostics ?? [])],
			DIAGNOSTIC_BUDGET_BYTES,
		),
	})
	const room = STORAGE_ROW_BYTES - measure(within("")) - FRAME_RESERVE_BYTES
	return within(retain === "tail" ? tailWithin(text, room) : headWithin(text, room))
}

const UNSTORABLE =
	"The tool's result was left out: it does not fit what a session keeps of one result, even after its details and images were cut. Ask for less at a time."

const unstorable = <R extends Stored>(result: R): R => ({
	...result,
	output: [{ type: "text", text: UNSTORABLE }],
	...(result.details === undefined ? {} : { details: DETAILS_CUT }),
	diagnostics: [],
	isError: true,
})

const STRUCTURED_TOO_LARGE =
	"The tool's structured result was left out: it does not fit what a session keeps of one result. Ask for less at a time."

const VALUE_TOO_LARGE =
	"The tool's result was left out: it does not fit what a session keeps of one result, even after its details and images were cut. Ask for less at a time."

const tooLarge = (result: ToolExecutionResult, message: string): ToolExecutionResult => {
	const { structuredOutput: _left, details: _cut, ...rest } = result
	return {
		...rest,
		output: [{ type: "text", text: message }],
		diagnostics: [{ severity: "error", code: "result_too_large", message }],
		isError: true,
	}
}

const NESTED_DETAILS_FRAME_BYTES = 64

const nestedFits = (result: Stored, nested: Nested, limits: ReadonlyArray<OutputLimits>) =>
	storedNestedBytes(result, nested, limits) <= STORAGE_ROW_BYTES

const outputIsKept = (result: Stored, nested: Nested) =>
	nested.forms.includes("value") ||
	(nested.forms.includes("structured") && toolErrorOf(result, result.output ?? []).length > 0)

const nestedValue = (
	result: ToolExecutionResult,
	nested: Nested,
	limits: ReadonlyArray<OutputLimits>,
): ToolExecutionResult | undefined => {
	if (nestedFits(result, nested, limits)) {
		return result
	}
	if (!outputIsKept(result, nested) || result.output === undefined) {
		return undefined
	}
	const textual = result.output.filter((item) => item.type !== "image")
	const room =
		STORAGE_ROW_BYTES -
		storedNestedBytes({ ...result, output: textual }, nested, limits) -
		IMAGES_CUT_RESERVE_BYTES
	const output = boundResultImages(result.output, room)
	const left = output.filter(
		(item, index) => item.type === "text" && result.output?.[index]?.type === "image",
	).length
	const cutNote =
		left === 0
			? undefined
			: boundResultDiagnostics(
					[imagesCut(left), ...(result.diagnostics ?? [])],
					DIAGNOSTIC_BUDGET_BYTES,
				)
	const imaged: ToolExecutionResult = {
		...result,
		output,
		...(cutNote === undefined ? {} : { diagnostics: cutNote }),
	}
	return nestedFits(imaged, nested, limits) ? imaged : undefined
}

export const boundNestedResult = (
	result: ToolExecutionResult,
	nested: Nested,
	limits: ReadonlyArray<OutputLimits> = [PI_DEFAULT_LIMITS],
): ToolExecutionResult => {
	const output = separate(result.output, limits)
	const diagnostics = boundResultDiagnostics(result.diagnostics, DIAGNOSTIC_BUDGET_BYTES)
	const kept =
		output === result.output && (diagnostics === result.diagnostics || diagnostics === undefined)
			? result
			: {
					...result,
					...(output === undefined ? {} : { output }),
					...(diagnostics === undefined ? {} : { diagnostics }),
				}
	if (nestedFits(kept, nested, limits)) {
		return kept
	}
	const { details: _details, ...withoutDetails } = kept
	const value = nestedValue(withoutDetails, nested, limits)
	if (value !== undefined) {
		const room =
			STORAGE_ROW_BYTES - storedNestedBytes(value, nested, limits) - NESTED_DETAILS_FRAME_BYTES
		const details = boundResultDetails(result.details, room)
		const trimmed = details === undefined ? value : { ...value, details }
		if (nestedFits(trimmed, nested, limits)) {
			return trimmed
		}
	}
	return tooLarge(
		result,
		nested.forms.includes("structured") ? STRUCTURED_TOO_LARGE : VALUE_TOO_LARGE,
	)
}

export const boundResult = <R extends Stored>(
	result: R,
	limits: ReadonlyArray<OutputLimits> = [PI_DEFAULT_LIMITS],
	call: CalledAs = UNNAMED,
): R => {
	const original = separate(result.output, limits)
	const bounded = boundResultDiagnostics(result.diagnostics, DIAGNOSTIC_BUDGET_BYTES)
	if (
		original === result.output &&
		bounded === result.diagnostics &&
		imageBytes(original ?? []) + serializedBytes(result.details) <= RESULT_BUDGET_BYTES &&
		storedRowBytes(result, limits, call) <= STORAGE_ROW_BYTES
	) {
		return result
	}
	const textual = original?.filter((item) => item.type !== "image")
	const base =
		storedRowBytes(
			{
				...(textual === undefined ? {} : { output: textual }),
				...(bounded === undefined ? {} : { diagnostics: bounded }),
				...(result.usage === undefined ? {} : { usage: result.usage }),
				...(result.isError === undefined ? {} : { isError: result.isError }),
			},
			limits,
			call,
		) + IMAGES_CUT_RESERVE_BYTES
	const room = Math.max(0, Math.min(RESULT_BUDGET_BYTES, STORAGE_ROW_BYTES - base))
	const images = original === undefined ? 0 : imageBytes(boundResultImages(original, room))
	const details = boundResultDetails(result.details, Math.max(0, room - images))
	const output =
		original === undefined
			? undefined
			: boundResultImages(original, room - serializedBytes(details))
	const left = (output ?? []).filter(
		(item, index) => item.type === "text" && original?.[index]?.type === "image",
	).length
	const diagnostics =
		left === 0
			? bounded
			: boundResultDiagnostics(
					[imagesCut(left), ...(result.diagnostics ?? [])],
					DIAGNOSTIC_BUDGET_BYTES,
				)
	const assemble = (kept: typeof output): R =>
		diagnostics === result.diagnostics && details === result.details && kept === result.output
			? result
			: {
					...result,
					...(kept === undefined ? {} : { output: kept }),
					...(details === undefined ? {} : { details }),
					...(diagnostics === undefined ? {} : { diagnostics }),
				}
	const whole = assemble(output)
	if (storedRowBytes(whole, limits, call) <= STORAGE_ROW_BYTES) {
		return whole
	}
	const merged = assemble(output === undefined ? undefined : coalesceResultText(output))
	if (storedRowBytes(merged, limits, call) <= STORAGE_ROW_BYTES) {
		return merged
	}
	const cut = shorten(merged, limits, (each) => storedRowBytes(each, limits, call))
	return storedRowBytes(cut, limits, call) <= STORAGE_ROW_BYTES ? cut : unstorable(result)
}

export const resultBoundsExtension = (
	tools: () => ReadonlyArray<
		Pick<ToolRegistration, "name" | "outputLimits" | "structuredOutputSchema">
	>,
) =>
	defineExtension({
		name: "checkfu.result-bounds",
		hooks: [
			hook(ToolTask, {
				afterTool: (call, result) => {
					const called = tools().filter((tool) => tool.name === call.name)
					const limits = [PI_DEFAULT_LIMITS, ...called.map(outputLimitsOf)]
					const bounded =
						call.parent === undefined
							? boundResult(result, limits, { id: call.id, name: call.name })
							: boundNestedResult(result, nestedFormsOf(called), limits)
					return bounded === result ? undefined : bounded
				},
			}),
		],
	})
