import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { Socket } from "node:net"
import type { JsonObject } from "@earendil-works/pi-durable"

export interface OpenAIInputMessage {
	readonly role: string
	readonly text: string
}

export interface RecordedOpenAIRequest {
	readonly id: number
	readonly authorization: string | undefined
	readonly model: string | undefined
	readonly body: JsonObject
	readonly messages: ReadonlyArray<OpenAIInputMessage>
	readonly userTexts: ReadonlyArray<string>
	readonly assistantTexts: ReadonlyArray<string>
	readonly lastUserText: string
	readonly toolNames: ReadonlyArray<string>
	readonly toolOutputs: ReadonlyArray<string>
	readonly aborted: () => boolean
	readonly waitAborted: Promise<void>
}

export type FakeOpenAIAction =
	| {
			readonly kind: "reply"
			readonly text: string
			readonly inputTokens?: number
			readonly outputTokens?: number
	  }
	| {
			readonly kind: "tool_call"
			readonly name: string
			readonly arguments: JsonObject
	  }
	| {
			readonly kind: "tool_calls"
			readonly calls: ReadonlyArray<{ readonly name: string; readonly arguments: JsonObject }>
	  }
	| {
			readonly kind: "hold"
			readonly release?: Promise<string | null>
	  }

export interface FakeOpenAIResponsesServer {
	readonly baseUrl: string
	readonly requests: ReadonlyArray<RecordedOpenAIRequest>
	readonly setHandler: (
		handler: (request: RecordedOpenAIRequest) => FakeOpenAIAction | Promise<FakeOpenAIAction>,
	) => void
	readonly waitForRequest: (
		predicate: (request: RecordedOpenAIRequest) => boolean,
		timeoutMs?: number,
	) => Promise<RecordedOpenAIRequest>
	readonly close: () => Promise<void>
}

const isRecord = (value: unknown): value is JsonObject =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const extractInputMessages = (input: unknown): ReadonlyArray<OpenAIInputMessage> => {
	if (!Array.isArray(input)) {
		return []
	}
	const messages: Array<OpenAIInputMessage> = []
	for (const item of input) {
		if (!isRecord(item) || typeof item.role !== "string") {
			continue
		}
		if (typeof item.content === "string") {
			messages.push({ role: item.role, text: item.content })
			continue
		}
		if (!Array.isArray(item.content)) {
			continue
		}
		const parts: Array<string> = []
		for (const part of item.content) {
			if (isRecord(part) && typeof part.text === "string") {
				parts.push(part.text)
			}
		}
		messages.push({ role: item.role, text: parts.join("") })
	}
	return messages
}

const extractToolNames = (tools: unknown): ReadonlyArray<string> =>
	Array.isArray(tools)
		? tools.flatMap((tool) => (isRecord(tool) && typeof tool.name === "string" ? [tool.name] : []))
		: []

const extractToolOutputsAfterLastUser = (input: unknown): ReadonlyArray<string> => {
	if (!Array.isArray(input)) {
		return []
	}
	const lastUser = input.findLastIndex((item) => isRecord(item) && item.role === "user")
	return input
		.slice(lastUser + 1)
		.flatMap((item) =>
			isRecord(item) && item.type === "function_call_output"
				? [typeof item.output === "string" ? item.output : JSON.stringify(item.output)]
				: [],
		)
}

const sseEvent = (event: string, data: JsonObject): string =>
	`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

const writeTextReplyEvents = (
	res: ServerResponse,
	responseId: string,
	messageId: string,
	text: string,
	inputTokens: number,
	outputTokens: number,
	alreadyCreated: boolean,
): void => {
	if (!alreadyCreated) {
		res.write(
			sseEvent("response.created", {
				type: "response.created",
				response: { id: responseId, status: "in_progress" },
			}),
		)
	}
	res.write(
		sseEvent("response.output_item.added", {
			type: "response.output_item.added",
			output_index: 0,
			item: {
				id: messageId,
				type: "message",
				role: "assistant",
				status: "in_progress",
				content: [],
			},
		}),
	)
	res.write(
		sseEvent("response.content_part.added", {
			type: "response.content_part.added",
			output_index: 0,
			content_index: 0,
			part: { type: "output_text", text: "" },
		}),
	)
	const splitAt = Math.max(1, Math.floor(text.length / 2))
	const chunks = text.length > 1 ? [text.slice(0, splitAt), text.slice(splitAt)] : [text]
	for (const delta of chunks) {
		res.write(
			sseEvent("response.output_text.delta", {
				type: "response.output_text.delta",
				output_index: 0,
				content_index: 0,
				delta,
			}),
		)
	}
	res.write(
		sseEvent("response.output_item.done", {
			type: "response.output_item.done",
			output_index: 0,
			item: {
				id: messageId,
				type: "message",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text }],
			},
		}),
	)
	res.write(
		sseEvent("response.completed", {
			type: "response.completed",
			response: {
				id: responseId,
				status: "completed",
				output: [
					{
						id: messageId,
						type: "message",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text }],
					},
				],
				usage: {
					input_tokens: inputTokens,
					output_tokens: outputTokens,
					total_tokens: inputTokens + outputTokens,
					input_tokens_details: { cached_tokens: 0 },
				},
			},
		}),
	)
	res.end()
}

const writeToolCallEvents = (
	res: ServerResponse,
	responseId: string,
	calls: ReadonlyArray<{
		readonly callId: string
		readonly name: string
		readonly args: JsonObject
	}>,
): void => {
	const items = calls.map((call) => ({
		id: `fc_${call.callId}`,
		type: "function_call",
		call_id: call.callId,
		name: call.name,
		arguments: JSON.stringify(call.args),
		status: "completed",
	}))
	res.write(
		sseEvent("response.created", {
			type: "response.created",
			response: { id: responseId, status: "in_progress" },
		}),
	)
	for (const [output_index, item] of items.entries()) {
		res.write(
			sseEvent("response.output_item.added", {
				type: "response.output_item.added",
				output_index,
				item: { ...item, arguments: "", status: "in_progress" },
			}),
		)
		res.write(
			sseEvent("response.function_call_arguments.delta", {
				type: "response.function_call_arguments.delta",
				item_id: item.id,
				output_index,
				delta: item.arguments,
			}),
		)
		res.write(
			sseEvent("response.function_call_arguments.done", {
				type: "response.function_call_arguments.done",
				item_id: item.id,
				output_index,
				arguments: item.arguments,
			}),
		)
		res.write(
			sseEvent("response.output_item.done", {
				type: "response.output_item.done",
				output_index,
				item,
			}),
		)
	}
	res.write(
		sseEvent("response.completed", {
			type: "response.completed",
			response: {
				id: responseId,
				status: "completed",
				output: items,
				usage: {
					input_tokens: 12,
					output_tokens: 6,
					total_tokens: 18,
					input_tokens_details: { cached_tokens: 0 },
				},
			},
		}),
	)
	res.end()
}

const readBody = (req: IncomingMessage): Promise<string> =>
	new Promise((resolve, reject) => {
		const chunks: Array<Buffer> = []
		req.on("data", (chunk: Buffer) => chunks.push(chunk))
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
		req.on("error", reject)
	})

export const startFakeOpenAIResponsesServer = async (
	initialHandler: (request: RecordedOpenAIRequest) => FakeOpenAIAction | Promise<FakeOpenAIAction>,
): Promise<FakeOpenAIResponsesServer> => {
	let handler = initialHandler
	let nextId = 1
	const requests: Array<RecordedOpenAIRequest> = []
	const waiters: Array<{
		readonly predicate: (request: RecordedOpenAIRequest) => boolean
		readonly resolve: (request: RecordedOpenAIRequest) => void
	}> = []
	const sockets = new Set<Socket>()

	const server = createServer((req, res) => {
		void (async () => {
			if (req.method !== "POST" || req.url !== "/v1/responses") {
				res.writeHead(404, { "content-type": "application/json" })
				res.end(JSON.stringify({ error: { message: "Not found" } }))
				return
			}

			const raw = await readBody(req)
			const parsed = JSON.parse(raw) as unknown
			const body = isRecord(parsed) ? parsed : {}
			const messages = extractInputMessages(body.input)
			const userTexts = messages.filter((m) => m.role === "user").map((m) => m.text)
			const assistantTexts = messages.filter((m) => m.role === "assistant").map((m) => m.text)
			const id = nextId++

			let aborted = false
			let resolveAborted!: () => void
			const waitAborted = new Promise<void>((resolve) => {
				resolveAborted = resolve
			})
			const markAborted = () => {
				if (res.writableEnded || aborted) {
					return
				}
				aborted = true
				resolveAborted()
			}
			req.on("aborted", markAborted)
			res.on("close", markAborted)

			const record: RecordedOpenAIRequest = {
				id,
				authorization: req.headers.authorization,
				model: typeof body.model === "string" ? body.model : undefined,
				body,
				messages,
				userTexts,
				assistantTexts,
				lastUserText: userTexts.at(-1) ?? "",
				toolNames: extractToolNames(body.tools),
				toolOutputs: extractToolOutputsAfterLastUser(body.input),
				aborted: () => aborted,
				waitAborted,
			}
			requests.push(record)

			for (let i = waiters.length - 1; i >= 0; i--) {
				const waiter = waiters[i]
				if (waiter !== undefined && waiter.predicate(record)) {
					waiters.splice(i, 1)
					waiter.resolve(record)
				}
			}

			const action = await handler(record)
			if (res.destroyed || aborted) {
				return
			}

			const responseId = `resp_fake_${id}`
			const messageId = `msg_fake_${id}`
			res.writeHead(200, {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache",
			})

			if (action.kind === "reply") {
				writeTextReplyEvents(
					res,
					responseId,
					messageId,
					action.text,
					action.inputTokens ?? 12,
					action.outputTokens ?? 6,
					false,
				)
				return
			}

			if (action.kind === "tool_call") {
				writeToolCallEvents(res, responseId, [
					{ callId: `call_fake_${id}`, name: action.name, args: action.arguments },
				])
				return
			}

			if (action.kind === "tool_calls") {
				writeToolCallEvents(
					res,
					responseId,
					action.calls.map((call, index) => ({
						callId: `call_fake_${id}_${index}`,
						name: call.name,
						args: call.arguments,
					})),
				)
				return
			}

			res.write(
				sseEvent("response.created", {
					type: "response.created",
					response: { id: responseId, status: "in_progress" },
				}),
			)
			if (action.release === undefined) {
				return
			}

			const released = await Promise.race([action.release, waitAborted.then(() => undefined)])
			if (aborted || res.destroyed || res.writableEnded) {
				return
			}
			if (released === null || released === undefined) {
				res.end()
				return
			}
			writeTextReplyEvents(res, responseId, messageId, released, 12, 6, true)
		})().catch((error: unknown) => {
			if (!res.headersSent) {
				res.writeHead(500, { "content-type": "application/json" })
			}
			if (!res.writableEnded) {
				res.end(JSON.stringify({ error: { message: String(error) } }))
			}
		})
	})

	server.on("connection", (socket) => {
		sockets.add(socket)
		socket.on("close", () => sockets.delete(socket))
	})

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject)
		server.listen(0, "127.0.0.1", () => resolve())
	})
	const address = server.address()
	if (address === null || typeof address === "string") {
		throw new Error("Expected TCP address for fake OpenAI server")
	}

	return {
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		requests,
		setHandler: (next) => {
			handler = next
		},
		waitForRequest: (predicate, timeoutMs = 15_000) => {
			const existing = requests.find(predicate)
			if (existing !== undefined) {
				return Promise.resolve(existing)
			}
			return new Promise<RecordedOpenAIRequest>((resolve, reject) => {
				const timer = setTimeout(() => {
					const idx = waiters.indexOf(entry)
					if (idx !== -1) {
						waiters.splice(idx, 1)
					}
					reject(new Error(`Timed out after ${timeoutMs}ms waiting for fake OpenAI request`))
				}, timeoutMs)
				const entry = {
					predicate,
					resolve: (request: RecordedOpenAIRequest) => {
						clearTimeout(timer)
						resolve(request)
					},
				}
				waiters.push(entry)
			})
		},
		close: async () => {
			for (const socket of sockets) {
				socket.destroy()
			}
			await new Promise<void>((resolve) => {
				server.close(() => {
					resolve()
				})
			})
		},
	}
}
