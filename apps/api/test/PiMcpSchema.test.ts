import { compile } from "@earendil-works/pi-schema"
import { describe, expect, it } from "@effect/vitest"
import type * as Schema from "effect/Schema"
import { mcpExtension, mcpRegistry } from "../src/Pi/PiMcp.ts"
import type { McpCallOutcome, McpToolDescriptor } from "../src/Pi/PiMcpTypes.ts"

const binding = {
	name: "docs",
	url: "https://docs.mcp.example/mcp",
	credential_id: null,
	vault_id: null,
}

const offered = (
	tools: ReadonlyArray<McpToolDescriptor>,
	answer: McpCallOutcome = { ok: true, content: [{ type: "text", text: "done" }], isError: false },
) => {
	const listed = { status: "listed" as const, tools }
	const sent: Array<Schema.JsonObject> = []
	const extension = mcpExtension(
		binding,
		listed,
		mcpRegistry([{ binding, tools: listed }]),
		(_binding, _tool, args) => {
			sent.push(args)
			return Promise.resolve(answer)
		},
	)
	const tool = (name: string) => {
		const registered = (extension.tools ?? []).find((entry) => entry.name === `mcp__docs__${name}`)
		expect(registered, name).toBeDefined()
		return registered!
	}
	return { tool, sent }
}

describe("An MCP server's JSON Schema", () => {
	it("is offered exactly as published: a `$ref` member of a literal value is data, and reaches the server unchanged", async () => {
		const inputSchema = {
			type: "object",
			properties: {
				ticket: { const: { $ref: "ticket-42" } },
				kind: { enum: [{ $ref: "https://example.com/a.json" }, "plain"] },
				note: {
					type: "object",
					default: { $ref: "elsewhere.json" },
					examples: [{ $ref: "https://example.com/b.json" }],
				},
			},
			required: ["ticket"],
		}
		const { tool, sent } = offered([{ name: "file", description: "Files a ticket.", inputSchema }])
		const registered = tool("file")
		expect(registered.parameters).toEqual(inputSchema)
		expect(registered.description).toBe("Files a ticket.")
		const args = {
			ticket: { $ref: "ticket-42" },
			kind: { $ref: "https://example.com/a.json" },
			note: { $ref: "elsewhere.json" },
		}
		expect(compile(registered.parameters as never).check(args)).toBe(true)
		await registered.execute(args, {} as never, {} as never)
		expect(sent).toEqual([args])
	})

	it("offers a tool whose schema Pi cannot check with any object as its arguments, says so, and still calls it", async () => {
		const { tool, sent } = offered([
			{
				name: "remote",
				description: "Uses a shared schema.",
				inputSchema: {
					type: "object",
					properties: { order: { $ref: "https://schemas.example.com/order.json" } },
				},
			},
			{
				name: "dangling",
				description: "",
				inputSchema: { type: "object", properties: { a: { $ref: "#/$defs/missing" } } },
			},
		])
		const remote = tool("remote")
		expect(remote.parameters).toEqual({ type: "object" })
		expect(remote.description).toMatch(/^Uses a shared schema\. .*could not be used.*unchecked\.$/)
		expect(tool("dangling").parameters).toEqual({ type: "object" })
		expect(tool("dangling").description).toMatch(/^The input schema .*unchecked\.$/)
		const args = { order: { id: 7, lines: [{ sku: "a" }] } }
		expect(await remote.execute(args, {} as never, {} as never)).toMatchObject({
			output: [{ type: "text", text: "done" }],
			isError: false,
		})
		expect(sent).toEqual([args])
	})

	it("types a result for scripts only by an output schema Pi can check; otherwise the script gets the text", async () => {
		const answer: McpCallOutcome = {
			ok: true,
			content: [],
			structuredContent: { total: 3 },
			isError: false,
		}
		const inputSchema = { type: "object" }
		const { tool } = offered(
			[
				{
					name: "typed",
					description: "",
					inputSchema,
					outputSchema: { type: "object", properties: { total: { const: { $ref: "x" } } } },
				},
				{
					name: "untyped",
					description: "",
					inputSchema,
					outputSchema: { $ref: "https://schemas.example.com/total.json" },
				},
			],
			answer,
		)
		expect(tool("typed").structuredOutputSchema).toEqual({
			type: "object",
			properties: { total: { const: { $ref: "x" } } },
		})
		expect(await tool("typed").execute({}, {} as never, {} as never)).toMatchObject({
			structuredOutput: { total: 3 },
		})
		expect(tool("untyped").structuredOutputSchema).toBeUndefined()
		const text = await tool("untyped").execute({}, {} as never, {} as never)
		expect(text).toMatchObject({ output: [{ type: "text", text: '{"total":3}' }] })
		expect(text).not.toHaveProperty("structuredOutput")
	})
})
