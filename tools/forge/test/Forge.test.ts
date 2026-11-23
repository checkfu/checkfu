import { spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parse } from "@cloudflare/forge"
import type { Json } from "@cloudflare/forge"
import { describe, expect, it } from "@effect/vitest"
import * as HttpApi from "effect/http-api/HttpApi"
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint"
import * as HttpApiGroup from "effect/http-api/HttpApiGroup"
import * as OpenApi from "effect/http-api/OpenApi"
import * as Schema from "effect/Schema"
import { generateCliFiles } from "../src/CliTransformer.ts"
import { REPO_ROOT } from "../src/Generate.ts"
import { exportDeterministicOpenApiJson } from "../src/OpenApiExport.ts"

describe("Cloudflare Forge pipeline", () => {
	it("exports a deterministic OpenAPI document that Forge resolves cleanly with no beta prefix", () => {
		const openApiJson = exportDeterministicOpenApiJson()
		using forge = parse(openApiJson)

		const resolved = forge.groups.flatMap((group) =>
			group.methods.map((method) => ({
				group: group.path.map((part) => part.kebab()).join(":"),
				name: method.name.kebab(),
				httpMethod: method.httpMethod,
				path: method.path,
			})),
		)

		expect(resolved).toEqual([
			{
				group: "agents",
				name: "archive",
				httpMethod: "POST",
				path: "/v1/agents/{agent_id}/archive",
			},
			{ group: "agents", name: "create", httpMethod: "POST", path: "/v1/agents" },
			{ group: "agents", name: "retrieve", httpMethod: "GET", path: "/v1/agents/{agent_id}" },
			{ group: "agents", name: "update", httpMethod: "POST", path: "/v1/agents/{agent_id}" },
			{
				group: "environments",
				name: "archive",
				httpMethod: "POST",
				path: "/v1/environments/{environment_id}/archive",
			},
			{ group: "environments", name: "create", httpMethod: "POST", path: "/v1/environments" },
			{
				group: "environments",
				name: "delete",
				httpMethod: "DELETE",
				path: "/v1/environments/{environment_id}",
			},
			{
				group: "environments",
				name: "retrieve",
				httpMethod: "GET",
				path: "/v1/environments/{environment_id}",
			},
			{
				group: "environments",
				name: "update",
				httpMethod: "POST",
				path: "/v1/environments/{environment_id}",
			},
			{
				group: "sessions",
				name: "archive",
				httpMethod: "POST",
				path: "/v1/sessions/{session_id}/archive",
			},
			{ group: "sessions", name: "create", httpMethod: "POST", path: "/v1/sessions" },
			{ group: "sessions", name: "retrieve", httpMethod: "GET", path: "/v1/sessions/{session_id}" },
			{
				group: "sessions:events",
				name: "list",
				httpMethod: "GET",
				path: "/v1/sessions/{session_id}/events",
			},
			{
				group: "sessions:events",
				name: "send",
				httpMethod: "POST",
				path: "/v1/sessions/{session_id}/events",
			},
			{
				group: "sessions:events",
				name: "stream",
				httpMethod: "GET",
				path: "/v1/sessions/{session_id}/events/stream",
			},
		])

		for (const item of resolved) {
			expect(item.group).not.toContain("beta")
			expect(item.name).not.toContain("beta")
		}

		// OpenAPI HTTP descriptions remain wire-format accurate (no CLI @file/YAML syntax),
		// listEvents cursor description documents both asc and desc order semantics,
		// and CLI flag help adds @file/YAML guidance from CLI metadata
		const spec = JSON.parse(openApiJson) as {
			paths: Record<string, Record<string, Record<string, Json>>>
		}
		const agentsPost = spec.paths["/v1/agents"]?.["post"]
		expect(agentsPost?.["description"]).toBe("Create an agent")
		const agentProps = (
			(agentsPost?.["requestBody"] as Record<string, Record<string, Record<string, Json>>>)?.[
				"content"
			]?.["application/json"]?.["schema"] as
				| { readonly properties?: Record<string, { readonly description?: string }> }
				| undefined
		)?.properties
		expect(agentProps?.["system"]?.description).toBe("System prompt text")
		expect(agentProps?.["model"]?.description).not.toContain("YAML")
		expect(agentProps?.["model"]?.description).not.toContain("@file")

		const listEventsParams = (spec.paths["/v1/sessions/{session_id}/events"]?.["get"]?.[
			"parameters"
		] ?? []) as ReadonlyArray<{ name: string; schema?: { description?: string } }>
		const afterParam = listEventsParams.find((p) => p.name === "after")
		expect(afterParam?.schema?.description).toContain("selected order")
		expect(afterParam?.schema?.description).toContain("desc")

		const cliCommands = generateCliFiles(forge).find((f) => f.path === "Commands.ts")?.content ?? ""
		expect(cliCommands).toContain('FlagWithDescription("System prompt text (supports @file)")')
		expect(cliCommands).toContain(
			'FlagWithDescription("Environment configuration object (JSON, YAML, or @file)")',
		)
		expect(cliCommands).toContain("accepts flags and/or JSON/YAML on stdin")
		expect(cliCommands).toContain('FlagInt("current-version")')
		expect(cliCommands).toContain('"flagName":"current-version","wireName":"version"')
		expect(cliCommands).not.toContain('FlagInt("version")')
	})

	it("bypasses OpenApi.fromApi caching so nondeterministic OpenAPI generation is detected", () => {
		let invocation = 0
		const unstableApi = HttpApi.make("unstable")
			.add(
				HttpApiGroup.make("items").add(
					HttpApiEndpoint.get("get", "/items", { success: Schema.String }),
				),
			)
			.annotate(OpenApi.Transform, (spec) => ({
				...spec,
				info: { ...spec.info, version: `0.0.${++invocation}` },
			}))

		expect(() => exportDeterministicOpenApiJson(unstableApi)).toThrow(/non-deterministic/)
		expect(invocation).toBe(2)
	})

	it("automatically emits a CLI command when a new endpoint is added to the OpenAPI spec", () => {
		const spec = JSON.parse(exportDeterministicOpenApiJson()) as {
			paths: Record<string, Record<string, Json>>
		}
		spec.paths["/v1/agents"] = {
			...spec.paths["/v1/agents"],
			get: {
				operationId: "agents.list",
				summary: "List agents",
				description: "List all agents",
				"x-forge-group-name": "agents",
				"x-forge-method-name": "list",
				"x-checkfu-endpoint": { group: "agents", endpoint: "list" },
				parameters: [
					{
						name: "limit",
						in: "query",
						required: false,
						description: "Page size",
						schema: { type: "integer" },
					},
				],
				responses: {
					"200": {
						description: "Success",
						content: { "application/json": { schema: { type: "object" } } },
					},
				},
			},
		}

		using forge = parse(JSON.stringify(spec))
		const files = generateCliFiles(forge)
		const commandsFile = files.find((f) => f.path === "Commands.ts")
		expect(commandsFile).toBeDefined()
		expect(commandsFile?.content).toContain('"list"')
		expect(commandsFile?.content).toContain('FlagInt("limit")')
		expect(commandsFile?.content).toContain('apiEndpoint: "list"')
	})

	it("passes Cloudflare Forge CLI inspect and native TypeScript SDK generation", () => {
		const openApiJson = exportDeterministicOpenApiJson()
		const forgeBin = join(REPO_ROOT, "node_modules", ".bin", "forge")

		const inspected = spawnSync(forgeBin, ["inspect", "methods", "-"], {
			cwd: REPO_ROOT,
			input: openApiJson,
			encoding: "utf8",
		})
		expect(inspected.status).toBe(0)
		const inspectedMethods = JSON.parse(inspected.stdout) as Array<{
			group: ReadonlyArray<string>
			name: string
		}>
		expect(inspectedMethods.length).toBe(15)

		const scratch = mkdtempSync(join(tmpdir(), "checkfu-forge-sdk-"))
		try {
			const sdkGen = spawnSync(forgeBin, ["generate", "-", "--target", "ts", "--out", scratch], {
				cwd: REPO_ROOT,
				input: openApiJson,
				encoding: "utf8",
			})
			expect(sdkGen.status).toBe(0)
			expect(readdirSync(scratch).length).toBeGreaterThan(0)
		} finally {
			rmSync(scratch, { recursive: true, force: true })
		}
	})
})
