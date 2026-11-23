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
import { generateSdkFiles } from "../src/SdkTransformer.ts"
import { buildSurfaceCatalog } from "../src/SurfaceCatalog.ts"

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

	it("automatically emits CLI and SDK methods when a new endpoint is added to the OpenAPI spec", () => {
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
		const cliFiles = generateCliFiles(forge)
		const commandsFile = cliFiles.find((f) => f.path === "Commands.ts")
		expect(commandsFile).toBeDefined()
		expect(commandsFile?.content).toContain('"list"')
		expect(commandsFile?.content).toContain('FlagInt("limit")')
		expect(commandsFile?.content).toContain('apiEndpoint: "list"')

		const sdkFiles = generateSdkFiles(forge)
		const resourcesFile = sdkFiles.find((f) => f.path === "Resources.ts")
		const bindingsFile = sdkFiles.find((f) => f.path === "OperationBindings.ts")
		expect(resourcesFile?.content).toContain('"agents.list"')
		expect(resourcesFile?.content).toContain('EndpointSuccess<"agents", "list">')
		expect(resourcesFile?.content).toContain('EndpointJsonSuccess<"agents", "list">')
		expect(resourcesFile?.content).toContain("new EffectAgentsResource(effectRuntime).list(")
		expect(bindingsFile?.content).toContain('operationId: "agents.list"')
		expect(bindingsFile?.content).toContain('cliCommand: "agents list"')
	})

	it("maintains 100% 1:1 operation parity across OpenAPI, SDK bindings, and generated CLI commands", () => {
		const openApiJson = exportDeterministicOpenApiJson()
		using forge = parse(openApiJson)
		const catalog = buildSurfaceCatalog(forge)
		const cliCommands = generateCliFiles(forge).find((f) => f.path === "Commands.ts")?.content ?? ""
		const sdkFiles = generateSdkFiles(forge)
		const sdkResources = sdkFiles.find((f) => f.path === "Resources.ts")?.content ?? ""
		const sdkBindings = sdkFiles.find((f) => f.path === "OperationBindings.ts")?.content ?? ""

		expect(catalog.operations.length).toBe(15)
		expect(sdkResources).not.toContain("beta")
		expect(sdkBindings).not.toContain("beta")

		for (const op of catalog.operations) {
			expect(cliCommands).toContain(`cliLabel: ${JSON.stringify(op.cliCommand)}`)
			expect(cliCommands).toContain(`apiGroup: ${JSON.stringify(op.apiGroup)}`)
			expect(cliCommands).toContain(`apiEndpoint: ${JSON.stringify(op.apiEndpoint)}`)
			expect(sdkBindings).toContain(`operationId: ${JSON.stringify(op.operationId)}`)
			expect(sdkBindings).toContain(`cliCommand: ${JSON.stringify(op.cliCommand)}`)
			expect(sdkResources).toContain(`${JSON.stringify(op.operationId)}: OperationShape<`)
		}
	})

	it("rejects reserved member names and subgroup/method collisions loudly during surface catalog build", () => {
		const reservedSpec = JSON.parse(exportDeterministicOpenApiJson()) as {
			paths: Record<string, Record<string, Json>>
		}
		reservedSpec.paths["/v1/agents/then"] = {
			get: {
				operationId: "agents.then",
				"x-forge-group-name": "agents",
				"x-forge-method-name": "then",
				"x-checkfu-endpoint": { group: "agents", endpoint: "then" },
				responses: {
					"200": {
						description: "Success",
						content: { "application/json": { schema: { type: "object" } } },
					},
				},
			},
		}
		using reservedForge = parse(JSON.stringify(reservedSpec))
		expect(() => buildSurfaceCatalog(reservedForge)).toThrow(/Reserved generated member name/)

		const collisionSpec = JSON.parse(exportDeterministicOpenApiJson()) as {
			paths: Record<string, Record<string, Json>>
		}
		collisionSpec.paths["/v1/sessions/events-summary"] = {
			get: {
				operationId: "sessions.events",
				"x-forge-group-name": "sessions",
				"x-forge-method-name": "events",
				"x-checkfu-endpoint": { group: "sessions", endpoint: "events" },
				responses: {
					"200": {
						description: "Success",
						content: { "application/json": { schema: { type: "object" } } },
					},
				},
			},
		}
		using collisionForge = parse(JSON.stringify(collisionSpec))
		expect(() => buildSurfaceCatalog(collisionForge)).toThrow(/Collision between subgroup/)
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
