import { MAX_TOOL_CALLS_PER_TURN } from "@checkfu/domain/Session/SessionTypes"
import type { ToolEvent } from "@checkfu/domain/Session/SessionTypes"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { AssistantMessage, Model, Api } from "@earendil-works/pi-ai"
import { ROOT_CONVERSATION_ID, ToolResultEntry, ToolTask, hook } from "@earendil-works/pi-durable"
import type { Context } from "@earendil-works/chord/context"
import type { EntryRecord, ToolExecutionApi, ToolExecutionResult } from "@earendil-works/pi-durable"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import fc from "fast-check"
import { readTurnToolEvents, runPiDurableTurn } from "../src/Pi/PiDurableEngine.ts"
import { createCheckfuRegistry } from "../src/Pi/PiRefusals.ts"
import { STORAGE_ROW_BYTES, serializedBytes } from "../src/Pi/PiResultBounds.ts"
import type { PiTurnRequest } from "../src/Pi/PiTurn.ts"
import { makeAssistantReply, makeScriptedPiModels } from "./helpers/ApiHarness.ts"
import { createInMemoryPiDurableBackend, storedWrites } from "./helpers/InMemoryPiBackend.ts"

type Behaviour =
	| "ok"
	| "error"
	| "throw"
	| "big"
	| "image"
	| "details"
	| "unknown"
	| "invalid"
	| "blocked"
	| "abort"
	| "mimic"
	| "repeat"
	| "failedLong"
	| "fanout"

type NestedTarget = "work" | "work_schema" | "dup" | "dup_flipped"

type NestedBehaviour = "ok" | "big" | "image" | "details" | "repeat" | "failedLong" | "structured"

type PlannedNested = {
	readonly target: NestedTarget
	readonly behaviour: NestedBehaviour
	readonly size: number
}

interface PlannedCall {
	readonly id: string
	readonly tag: string
	readonly behaviour: Behaviour
	readonly size: number
	readonly nested: ReadonlyArray<PlannedNested>
}

interface PlannedRound {
	readonly calls: ReadonlyArray<PlannedCall>
	readonly failedFirst: boolean
}

interface Ran {
	readonly tag: string
	readonly name: string
}

const NOT_RUN: ReadonlySet<Behaviour> = new Set<Behaviour>(["unknown", "invalid", "blocked"])

interface WorkArgs {
	readonly tag: string
	readonly mode: string
	readonly size?: number
	readonly nested?: ReadonlyArray<PlannedNested>
}

const toolName = (call: PlannedCall) =>
	call.behaviour === "unknown" ? "missing_tool" : call.behaviour === "abort" ? "work_seq" : "work"

const argumentsOf = (call: PlannedCall) =>
	call.behaviour === "invalid"
		? { tag: call.tag, mode: { not: "a string" } }
		: call.behaviour === "fanout"
			? { tag: call.tag, mode: call.behaviour, size: call.size, nested: call.nested }
			: { tag: call.tag, mode: call.behaviour, size: call.size }

const toolCallMessage = (
	model: Model<Api>,
	calls: ReadonlyArray<PlannedCall>,
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage => ({
	...makeAssistantReply(model, null, "", 2, 1),
	content: calls.map((call) => ({
		type: "toolCall" as const,
		id: call.id,
		name: toolName(call),
		arguments: argumentsOf(call),
	})),
	stopReason,
	...(stopReason === "error" ? { errorMessage: "overloaded" } : {}),
})

const resultOf = (args: WorkArgs): ToolExecutionResult => {
	const tag = args.tag
	const size = args.size ?? 0
	switch (args.mode) {
		case "error":
			return { output: [{ type: "text", text: `err:${tag}` }], isError: true }
		case "throw":
			throw new Error(`boom:${tag}`)
		case "mimic":
			return {
				output: [{ type: "text", text: `err:${tag}` }],
				isError: true,
				diagnostics: [
					{ severity: "error", code: "blocked", message: "the tool's own" },
					{ severity: "error", code: "invalid_arguments", message: "the tool's own" },
				],
			}
		case "big":
			return { output: [{ type: "text", text: `ok:${tag}:${"x".repeat(size)}` }] }
		case "image":
			return {
				output: [
					{ type: "text", text: `ok:${tag}` },
					{ type: "image", data: "A".repeat(size), mimeType: "image/png" },
				],
			}
		case "details":
			return { output: [{ type: "text", text: `ok:${tag}` }], details: { log: "d".repeat(size) } }
		case "repeat": {
			const block = {
				type: "text" as const,
				text: `ok:${tag}:${"r".repeat(80_000)}`,
			}
			return { output: Array.from({ length: 40 }, () => block) }
		}
		case "failedLong":
			return {
				output: [{ type: "text", text: `err:${tag}:${"e".repeat(size)}` }],
				isError: true,
				details: { log: "d".repeat(size) },
			}
		case "structured":
			return { output: [{ type: "text", text: `ok:${tag}` }] }
		default:
			return { output: [{ type: "text", text: `ok:${tag}` }] }
	}
}

const schemaResultOf = (args: WorkArgs): ToolExecutionResult => {
	const plain = resultOf(args)
	return plain.isError === true
		? plain
		: {
				...plain,
				structuredOutput: {
					tag: args.tag,
					data: args.mode === "structured" ? "s".repeat(args.size ?? 0) : "",
				},
			}
}

const runTurn = async (rounds: ReadonlyArray<PlannedRound>) => {
	const ran: Array<Ran> = []
	const request: PiTurnRequest = {
		operationId: "turn:1",
		turn: 1,
		provider: "openai",
		modelId: "gpt-4o-mini",
		system: null,
		text: "use the tools",
	}
	let abort: () => void = () => undefined
	const registry = createCheckfuRegistry()
	const execute =
		(name: string, schema = false) =>
		async (
			args: WorkArgs,
			api: ToolExecutionApi,
			context: Context,
		): Promise<ToolExecutionResult> => {
			ran.push({ tag: args.tag, name })
			if (args.mode === "abort") {
				abort()
			}
			if (args.mode === "fanout") {
				for (const [index, each] of (args.nested ?? []).entries()) {
					await api.executeTool(
						each.target,
						{ tag: `${args.tag}n${index}`, mode: each.behaviour, size: each.size },
						context,
						{ key: `n${index}` },
					)
				}
				return { output: [{ type: "text", text: `ok:${args.tag}` }] }
			}
			return schema ? schemaResultOf(args) : resultOf(args)
		}
	const parameters = {
		type: "object",
		properties: {
			tag: { type: "string" },
			mode: { type: "string" },
			size: { type: "number" },
			nested: { type: "array" },
		},
		required: ["tag", "mode"],
	} as const
	registry.install({
		name: "property-tools",
		tools: [
			{
				name: "work",
				description: "Do some work.",
				parameters,
				replay: "safe",
				execute: execute("work"),
			},
			{
				name: "work_seq",
				description: "Do some work, one call at a time.",
				parameters,
				replay: "safe",
				executionMode: "sequential",
				execute: execute("work_seq"),
			},
			{
				name: "work_schema",
				description: "Do some work and say so as data.",
				parameters,
				structuredOutputSchema: { type: "object" },
				outputLimits: { maxBytes: 4 * 1024 * 1024, maxLines: 100_000 },
				replay: "safe",
				execute: execute("work_schema", true),
			},
			{
				name: "dup",
				description: "One of two tools of this name.",
				parameters,
				replay: "safe",
				execute: execute("dup"),
			},
			{
				name: "dup_flipped",
				description: "One of two tools of this name, the one with a schema.",
				parameters,
				structuredOutputSchema: { type: "object" },
				outputLimits: { maxBytes: 4 * 1024 * 1024, maxLines: 100_000 },
				replay: "safe",
				execute: execute("dup_flipped", true),
			},
		],
		hooks: [
			hook(ToolTask, {
				beforeTool: (call) =>
					call.arguments["mode"] === "blocked" ? { block: "not allowed here" } : undefined,
			}),
		],
	})
	registry.install({
		name: "property-tools-again",
		tools: [
			{
				name: "dup",
				description: "The other tool of this name.",
				parameters,
				structuredOutputSchema: { type: "object" },
				outputLimits: { maxBytes: 4 * 1024 * 1024, maxLines: 100_000 },
				replay: "safe",
				execute: execute("dup", true),
			},
			{
				name: "dup_flipped",
				description: "The other tool of this name, without a schema.",
				parameters,
				replay: "safe",
				execute: execute("dup_flipped"),
			},
		],
	})
	const script: Array<(model: Model<Api>) => AssistantMessage> = []
	for (const round of rounds) {
		if (round.failedFirst) {
			script.push((model) => toolCallMessage(model, round.calls, "error"))
		}
		script.push((model) => toolCallMessage(model, round.calls, "toolUse"))
	}
	let step = 0
	const written = storedWrites.length
	const backend = await createInMemoryPiDurableBackend(
		makeScriptedPiModels(async (model) => {
			const next = script[step]
			step += 1
			return next === undefined ? makeAssistantReply(model, null, "Done.", 2, 1) : next(model)
		}),
		1,
		registry,
	)
	abort = () => {
		void Effect.runPromise(backend.abort(request.operationId))
	}
	try {
		await Effect.runPromise(runPiDurableTurn(backend, request))
		const pi = await backend.pi()
		const first = await readTurnToolEvents(pi, request.operationId, request.turn)
		const again = await readTurnToolEvents(pi, request.operationId, request.turn)
		const conversation = await pi.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT)
		const stored: Array<EntryRecord> = []
		let cursor: Parameters<NonNullable<typeof conversation>["entries"]>[2]
		do {
			const page = await conversation!.entries(
				{ order: "ascending" },
				64,
				cursor,
				BACKGROUND_CONTEXT,
			)
			stored.push(...page.items)
			cursor = page.next
		} while (cursor !== undefined)
		return { ran, first, again, stored, writes: storedWrites.slice(written) }
	} finally {
		await backend.close()
	}
}

const sizeFor = fc.oneof(
	{ weight: 6, arbitrary: fc.integer({ min: 0, max: 200 }) },
	{ weight: 1, arbitrary: fc.integer({ min: 1_500_000, max: 2_600_000 }) },
)

const ids = fc.oneof(
	{ weight: 6, arbitrary: fc.constantFrom("a", "b", "c", "d") },
	{ weight: 1, arbitrary: fc.integer({ min: 100_000, max: 400_000 }).map((n) => "L".repeat(n)) },
)

const behaviour = fc.constantFrom<Behaviour>(
	"ok",
	"ok",
	"error",
	"throw",
	"big",
	"image",
	"details",
	"unknown",
	"invalid",
	"blocked",
	"abort",
	"mimic",
	"repeat",
	"failedLong",
	"fanout",
	"fanout",
)

const nestedPlan = fc.array(
	fc.record({
		target: fc.constantFrom<NestedTarget>("work", "work_schema", "dup", "dup_flipped"),
		behaviour: fc.constantFrom<NestedBehaviour>(
			"ok",
			"big",
			"image",
			"details",
			"repeat",
			"failedLong",
			"structured",
		),
		size: sizeFor,
	}),
	{ minLength: 1, maxLength: 3 },
)

const plan = fc
	.array(
		fc.record({
			calls: fc.array(fc.record({ id: ids, behaviour, size: sizeFor, nested: nestedPlan }), {
				minLength: 1,
				maxLength: 4,
			}),
			failedFirst: fc.boolean(),
		}),
		{ minLength: 1, maxLength: 3 },
	)
	.map((rounds) =>
		rounds.map((round, r) => ({
			failedFirst: round.failedFirst,
			calls: round.calls.map((call, c) => ({ ...call, tag: `r${r}c${c}` })),
		})),
	)

const usesOf = (events: ReadonlyArray<ToolEvent>) =>
	events.flatMap((event) => (event.type === "tool_use" ? [event] : []))

const resultFor = (events: ReadonlyArray<ToolEvent>, id: string) =>
	events.find((event) => event.type === "tool_result" && event.tool_use_id === id)

const tagOf = (event: ToolEvent) =>
	event.type === "tool_use" && typeof event.input["tag"] === "string"
		? event.input["tag"]
		: undefined

const check = (
	rounds: ReadonlyArray<PlannedRound>,
	outcome: Awaited<ReturnType<typeof runTurn>>,
) => {
	const { ran, first, again, stored, writes } = outcome
	expect(again).toEqual(first)
	for (const write of writes) {
		if (write.kind === "pi.tool-result" || write.kind === "pi.tool.nested-call") {
			expect(write.bytes, write.kind).toBeLessThanOrEqual(STORAGE_ROW_BYTES)
		}
	}
	for (const entry of stored) {
		if (ToolResultEntry.is(entry)) {
			expect(serializedBytes(entry)).toBeLessThanOrEqual(STORAGE_ROW_BYTES)
		}
	}
	const ranTags = new Set(ran.map((each) => each.tag))
	const planned = rounds.flatMap((round) => round.calls)
	const duplicated = new Set(
		rounds.flatMap((round) =>
			round.calls
				.filter((call) => round.calls.filter((other) => other.id === call.id).length > 1)
				.map((call) => call.tag),
		),
	)
	const uses = usesOf(first)
	expect(new Set(uses.map((use) => use.tool_use_id)).size).toBe(uses.length)
	const published = uses.map(tagOf)
	for (const tag of duplicated) {
		expect(published).not.toContain(tag)
	}
	const expected = planned.flatMap((call) =>
		ranTags.has(call.tag) && !duplicated.has(call.tag) ? [call.tag] : [],
	)
	const publishedRan = published.filter((tag) => tag !== undefined && ranTags.has(tag))
	expect(publishedRan.length).toBe(Math.min(MAX_TOOL_CALLS_PER_TURN, expected.length))
	expect(publishedRan).toEqual(expected.filter((tag) => publishedRan.includes(tag)))
	for (const use of uses) {
		const tag = tagOf(use)
		const call = planned.find((each) => each.tag === tag)
		expect(call).toBeDefined()
		if (call === undefined) {
			continue
		}
		expect(use.name).toBe(toolName(call))
		if (use.truncated !== true) {
			expect(use.input).toEqual(argumentsOf(call))
		}
		const result = resultFor(first, use.tool_use_id)
		expect(result).toBeDefined()
		if (result?.type !== "tool_result") {
			continue
		}
		const text = result.content.map((block) => block.text).join("")
		if (result.rejected !== undefined) {
			expect(ranTags.has(call.tag)).toBe(false)
			continue
		}
		if (!ranTags.has(call.tag)) {
			expect(result.is_error).toBe(true)
			continue
		}
		switch (call.behaviour) {
			case "error":
			case "mimic":
			case "failedLong":
				expect(result.is_error).toBe(true)
				expect(text).toContain(`err:${call.tag}`)
				break
			case "throw":
				expect(result.is_error).toBe(true)
				expect(text).toContain(`boom:${call.tag}`)
				break
			case "abort":
				break
			default:
				expect(result.is_error).toBe(false)
				expect(text.startsWith(`ok:${call.tag}`) || result.truncated === true).toBe(true)
		}
	}
	for (const call of planned) {
		if (NOT_RUN.has(call.behaviour) && !duplicated.has(call.tag)) {
			expect(ranTags.has(call.tag)).toBe(false)
		}
	}
}

const RUNS = Number(process.env["PI_PROPERTY_RUNS"] ?? (process.env["CI"] === undefined ? 200 : 50))

const fanout = (tag: string, nested: ReadonlyArray<PlannedNested>): PlannedRound => ({
	failedFirst: false,
	calls: [{ id: "a", tag, behaviour: "fanout", size: 0, nested }],
})

const discardedThenRan: ReadonlyArray<PlannedRound> = [
	...Array.from({ length: MAX_TOOL_CALLS_PER_TURN + 1 }, (_, r) => ({
		failedFirst: false,
		calls: [0, 1].map((c) => ({
			id: `twin-${r}`,
			tag: `r${r}c${c}`,
			behaviour: "ok" as const,
			size: 0,
			nested: [],
		})),
	})),
	{
		failedFirst: false,
		calls: [
			{
				id: "last",
				tag: `r${MAX_TOOL_CALLS_PER_TURN + 1}c0`,
				behaviour: "ok" as const,
				size: 0,
				nested: [],
			},
		],
	},
]

const HARD_CASES: ReadonlyArray<readonly [string, ReadonlyArray<PlannedRound>]> = [
	["more than the turn's calls in discarded reservations, then a call that ran", discardedThenRan],
	[
		"a schema tool's long error text, which Pi turns into a diagnostic",
		[fanout("r0c0", [{ target: "work_schema", behaviour: "failedLong", size: 1_500_000 }])],
	],
	[
		"one text object repeated in a nested result Pi truncates",
		[fanout("r0c0", [{ target: "work", behaviour: "repeat", size: 0 }])],
	],
	[
		"a large image from a tool whose name two registrations share",
		[
			fanout("r0c0", [
				{ target: "dup", behaviour: "image", size: 2_400_000 },
				{ target: "dup_flipped", behaviour: "image", size: 2_400_000 },
			]),
		],
	],
]

describe("What a turn publishes matches what Pi ran", () => {
	it.each(HARD_CASES)(
		"keeps what Pi stores under one row for %s",
		async (_name, rounds) => {
			check(rounds, await runTurn(rounds))
		},
		120_000,
	)

	it("publishes every call that ran once, in call order, and never says a call that ran did not", async () => {
		await fc.assert(
			fc.asyncProperty(plan, async (rounds) => {
				const outcome = await runTurn(rounds)
				try {
					check(rounds, outcome)
				} catch (error) {
					const short = (id: string) => (id.length > 8 ? `L*${id.length}` : id)
					const plan = rounds.map((round) => ({
						...round,
						calls: round.calls.map((call) => ({ ...call, id: short(call.id) })),
					}))
					const published = outcome.first.map((event) =>
						event.type === "tool_use"
							? `use:${tagOf(event)}:${event.name}`
							: `result:${event.is_error}:${event.rejected ?? ""}`,
					)
					throw new Error(
						`plan ${JSON.stringify(plan)} ran ${JSON.stringify(outcome.ran)} published ${JSON.stringify(published)}`,
						{ cause: error },
					)
				}
			}),
			{ numRuns: RUNS },
		)
	}, 600_000)
})
