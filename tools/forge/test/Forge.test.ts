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
			{ group: "agents", name: "list", httpMethod: "GET", path: "/v1/agents" },
			{ group: "agents", name: "retrieve", httpMethod: "GET", path: "/v1/agents/{agent_id}" },
			{ group: "agents", name: "update", httpMethod: "POST", path: "/v1/agents/{agent_id}" },
			{
				group: "agents:versions",
				name: "list",
				httpMethod: "GET",
				path: "/v1/agents/{agent_id}/versions",
			},
			{ group: "artifacts", name: "create", httpMethod: "POST", path: "/v1/artifacts" },
			{
				group: "artifacts",
				name: "delete",
				httpMethod: "DELETE",
				path: "/v1/artifacts/{artifact_id}",
			},
			{ group: "artifacts", name: "list", httpMethod: "GET", path: "/v1/artifacts" },
			{
				group: "artifacts",
				name: "publish",
				httpMethod: "POST",
				path: "/v1/artifacts/{artifact_id}/publication",
			},
			{
				group: "artifacts",
				name: "retrieve",
				httpMethod: "GET",
				path: "/v1/artifacts/{artifact_id}",
			},
			{
				group: "artifacts",
				name: "unpublish",
				httpMethod: "DELETE",
				path: "/v1/artifacts/{artifact_id}/publication",
			},
			{
				group: "artifacts:versions",
				name: "create",
				httpMethod: "POST",
				path: "/v1/artifacts/{artifact_id}/versions",
			},
			{
				group: "artifacts:versions",
				name: "file",
				httpMethod: "GET",
				path: "/v1/artifacts/{artifact_id}/versions/{version}/file",
			},
			{
				group: "artifacts:versions",
				name: "link",
				httpMethod: "POST",
				path: "/v1/artifacts/{artifact_id}/versions/{version}/links",
			},
			{
				group: "artifacts:versions",
				name: "retrieve",
				httpMethod: "GET",
				path: "/v1/artifacts/{artifact_id}/versions/{version}",
			},
			{
				group: "automation-runs",
				name: "retrieve",
				httpMethod: "GET",
				path: "/v1/automation_runs/{automation_run_id}",
			},
			{
				group: "automations",
				name: "archive",
				httpMethod: "POST",
				path: "/v1/automations/{automation_id}/archive",
			},
			{ group: "automations", name: "create", httpMethod: "POST", path: "/v1/automations" },
			{ group: "automations", name: "list", httpMethod: "GET", path: "/v1/automations" },
			{
				group: "automations",
				name: "pause",
				httpMethod: "POST",
				path: "/v1/automations/{automation_id}/pause",
			},
			{
				group: "automations",
				name: "retrieve",
				httpMethod: "GET",
				path: "/v1/automations/{automation_id}",
			},
			{
				group: "automations",
				name: "run",
				httpMethod: "POST",
				path: "/v1/automations/{automation_id}/run",
			},
			{
				group: "automations",
				name: "unpause",
				httpMethod: "POST",
				path: "/v1/automations/{automation_id}/unpause",
			},
			{
				group: "automations",
				name: "update",
				httpMethod: "POST",
				path: "/v1/automations/{automation_id}",
			},
			{
				group: "automations:runs",
				name: "list",
				httpMethod: "GET",
				path: "/v1/automations/{automation_id}/runs",
			},
			{
				group: "automations:runs",
				name: "retrieve",
				httpMethod: "GET",
				path: "/v1/automations/{automation_id}/runs/{run}",
			},
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
			{ group: "environments", name: "list", httpMethod: "GET", path: "/v1/environments" },
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
				group: "memory-stores",
				name: "archive",
				httpMethod: "POST",
				path: "/v1/memory_stores/{memory_store_id}/archive",
			},
			{
				group: "memory-stores",
				name: "create",
				httpMethod: "POST",
				path: "/v1/memory_stores",
			},
			{
				group: "memory-stores",
				name: "delete",
				httpMethod: "DELETE",
				path: "/v1/memory_stores/{memory_store_id}",
			},
			{
				group: "memory-stores",
				name: "list",
				httpMethod: "GET",
				path: "/v1/memory_stores",
			},
			{
				group: "memory-stores",
				name: "retrieve",
				httpMethod: "GET",
				path: "/v1/memory_stores/{memory_store_id}",
			},
			{
				group: "memory-stores",
				name: "update",
				httpMethod: "POST",
				path: "/v1/memory_stores/{memory_store_id}",
			},
			{
				group: "memory-stores:memories",
				name: "create",
				httpMethod: "POST",
				path: "/v1/memory_stores/{memory_store_id}/memories",
			},
			{
				group: "memory-stores:memories",
				name: "delete",
				httpMethod: "DELETE",
				path: "/v1/memory_stores/{memory_store_id}/memories/{memory_id}",
			},
			{
				group: "memory-stores:memories",
				name: "list",
				httpMethod: "GET",
				path: "/v1/memory_stores/{memory_store_id}/memories",
			},
			{
				group: "memory-stores:memories",
				name: "retrieve",
				httpMethod: "GET",
				path: "/v1/memory_stores/{memory_store_id}/memories/{memory_id}",
			},
			{
				group: "memory-stores:memories",
				name: "update",
				httpMethod: "POST",
				path: "/v1/memory_stores/{memory_store_id}/memories/{memory_id}",
			},
			{
				group: "sessions",
				name: "archive",
				httpMethod: "POST",
				path: "/v1/sessions/{session_id}/archive",
			},
			{ group: "sessions", name: "create", httpMethod: "POST", path: "/v1/sessions" },
			{ group: "sessions", name: "list", httpMethod: "GET", path: "/v1/sessions" },
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
			{
				group: "sessions:outputs",
				name: "retrieve",
				httpMethod: "GET",
				path: "/v1/sessions/{session_id}/outputs",
			},
			{
				group: "sessions:resources",
				name: "list",
				httpMethod: "GET",
				path: "/v1/sessions/{session_id}/resources",
			},
			{
				group: "sessions:resources",
				name: "retrieve",
				httpMethod: "GET",
				path: "/v1/sessions/{session_id}/resources/{resource_id}",
			},
			{
				group: "sessions:resources",
				name: "update",
				httpMethod: "POST",
				path: "/v1/sessions/{session_id}/resources/{resource_id}",
			},
			{
				group: "vaults",
				name: "archive",
				httpMethod: "POST",
				path: "/v1/vaults/{vault_id}/archive",
			},
			{
				group: "vaults",
				name: "create",
				httpMethod: "POST",
				path: "/v1/vaults",
			},
			{
				group: "vaults",
				name: "delete",
				httpMethod: "DELETE",
				path: "/v1/vaults/{vault_id}",
			},
			{
				group: "vaults",
				name: "list",
				httpMethod: "GET",
				path: "/v1/vaults",
			},
			{
				group: "vaults",
				name: "retrieve",
				httpMethod: "GET",
				path: "/v1/vaults/{vault_id}",
			},
			{
				group: "vaults",
				name: "update",
				httpMethod: "POST",
				path: "/v1/vaults/{vault_id}",
			},
			{
				group: "vaults:credentials",
				name: "archive",
				httpMethod: "POST",
				path: "/v1/vaults/{vault_id}/credentials/{credential_id}/archive",
			},
			{
				group: "vaults:credentials",
				name: "create",
				httpMethod: "POST",
				path: "/v1/vaults/{vault_id}/credentials",
			},
			{
				group: "vaults:credentials",
				name: "delete",
				httpMethod: "DELETE",
				path: "/v1/vaults/{vault_id}/credentials/{credential_id}",
			},
			{
				group: "vaults:credentials",
				name: "list",
				httpMethod: "GET",
				path: "/v1/vaults/{vault_id}/credentials",
			},
			{
				group: "vaults:credentials",
				name: "retrieve",
				httpMethod: "GET",
				path: "/v1/vaults/{vault_id}/credentials/{credential_id}",
			},
			{
				group: "vaults:credentials",
				name: "update",
				httpMethod: "POST",
				path: "/v1/vaults/{vault_id}/credentials/{credential_id}",
			},
			{ group: "webhooks", name: "create", httpMethod: "POST", path: "/v1/webhooks" },
			{
				group: "webhooks",
				name: "delete",
				httpMethod: "DELETE",
				path: "/v1/webhooks/{webhook_id}",
			},
			{ group: "webhooks", name: "list", httpMethod: "GET", path: "/v1/webhooks" },
			{
				group: "webhooks",
				name: "pause",
				httpMethod: "POST",
				path: "/v1/webhooks/{webhook_id}/pause",
			},
			{
				group: "webhooks",
				name: "resume",
				httpMethod: "POST",
				path: "/v1/webhooks/{webhook_id}/resume",
			},
			{
				group: "webhooks",
				name: "retrieve",
				httpMethod: "GET",
				path: "/v1/webhooks/{webhook_id}",
			},
			{
				group: "webhooks",
				name: "rotate-secret",
				httpMethod: "POST",
				path: "/v1/webhooks/{webhook_id}/rotate-secret",
			},
			{
				group: "webhooks",
				name: "test",
				httpMethod: "POST",
				path: "/v1/webhooks/{webhook_id}/test",
			},
			{
				group: "webhooks",
				name: "update",
				httpMethod: "POST",
				path: "/v1/webhooks/{webhook_id}",
			},
			{
				group: "webhooks:deliveries",
				name: "list",
				httpMethod: "GET",
				path: "/v1/webhooks/{webhook_id}/deliveries",
			},
			{
				group: "webhooks:deliveries",
				name: "redeliver",
				httpMethod: "POST",
				path: "/v1/webhooks/{webhook_id}/deliveries/{delivery_id}/redeliver",
			},
			{
				group: "webhooks:deliveries",
				name: "retrieve",
				httpMethod: "GET",
				path: "/v1/webhooks/{webhook_id}/deliveries/{delivery_id}",
			},
		])

		for (const item of resolved) {
			expect(item.group).not.toContain("beta")
			expect(item.name).not.toContain("beta")
		}

		const spec = JSON.parse(openApiJson) as {
			paths: Record<string, Record<string, Record<string, Json>>>
		}
		const agentsPost = spec.paths["/v1/agents"]?.["post"]
		expect(agentsPost?.["description"]).toBe(
			"Create a reusable agent configuration with a model and an optional system prompt.",
		)
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
		expect(listEventsParams.map((param) => param.name)).not.toContain("after")
		const pageParam = listEventsParams.find((param) => param.name === "page")
		expect(pageParam?.schema?.description).toContain("next_page")
		const orderParam = listEventsParams.find((param) => param.name === "order")
		expect(orderParam?.schema?.description).toContain("desc")

		const cliCommands = generateCliFiles(forge).find((f) => f.path === "Commands.ts")?.content ?? ""
		expect(cliCommands).toContain('FlagWithDescription("System prompt text (supports @file)")')
		expect(cliCommands).toContain(
			'FlagWithDescription("Environment configuration object (JSON, YAML, or @file)")',
		)
		expect(cliCommands).toContain("accepts flags and/or JSON/YAML on stdin")
		expect(cliCommands).toContain('FlagInt("current-version")')
		expect(cliCommands).toContain('"flagName":"current-version","wireName":"version"')
		expect(cliCommands).not.toContain('FlagInt("version")')
		expect(cliCommands).not.toContain('FlagString("authorization-token")')
		expect(cliCommands).not.toContain('"flagName":"resources"')
		expect(cliCommands).not.toContain('FlagString("resources")')
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

	it("makes a required query parameter a required CLI flag and carries a command's input bound", () => {
		const spec = JSON.parse(exportDeterministicOpenApiJson()) as {
			paths: Record<string, Record<string, Json>>
		}
		spec.paths["/v1/agents/lookup"] = {
			get: {
				operationId: "agents.lookup",
				summary: "Look up an agent",
				description: "Look up an agent by name",
				"x-forge-group-name": "agents",
				"x-forge-method-name": "lookup",
				"x-checkfu-endpoint": { group: "agents", endpoint: "lookup" },
				"x-checkfu-cli": { maxInputBytes: 12_345 },
				parameters: [
					{ name: "name", in: "query", required: true, schema: { type: "string" } },
					{ name: "limit", in: "query", required: true, schema: { type: "integer" } },
					{ name: "order", in: "query", required: false, schema: { type: "string" } },
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
		const commands = generateCliFiles(forge).find((f) => f.path === "Commands.ts")?.content ?? ""
		const start = commands.indexOf("const agentsLookupCommandSpec")
		const lookup = commands.slice(
			start,
			commands.indexOf("\n\nconst ", commands.indexOf("const agentsLookupCommand =")),
		)
		expect(lookup).toContain("maxInputBytes: 12_345,")
		expect(lookup).toContain(
			'"flagName":"name","wireName":"name","location":"query","kind":"string","required":true',
		)
		expect(lookup).toContain(
			'"flagName":"limit","wireName":"limit","location":"query","kind":"int","required":true',
		)
		expect(lookup).toContain(
			'"flagName":"order","wireName":"order","location":"query","kind":"string","required":false',
		)
		expect(lookup.split("FlagOptional")).toHaveLength(2)
		expect(lookup).toMatch(/order: FlagString\("order"\)\.pipe\([^)]*\),\s*FlagOptional,/)

		const agentsCreate = commands.slice(
			commands.indexOf("const agentsCreateCommandSpec"),
			commands.indexOf("const agentsCreateCommand ="),
		)
		expect(agentsCreate).not.toContain("maxInputBytes")
		const fileStart = commands.indexOf("const artifactsVersionsFileCommandSpec")
		const fileCommand = commands.slice(
			fileStart,
			commands.indexOf(
				"\n\nconst ",
				commands.indexOf("const artifactsVersionsFileCommand =", fileStart),
			),
		)
		expect(fileCommand).toContain(
			'"flagName":"file","wireName":"file","location":"query","kind":"string","required":true',
		)
		expect(fileCommand).not.toContain("FlagOptional")
	})

	it("maintains 100% 1:1 operation parity across OpenAPI, SDK bindings, and generated CLI commands", () => {
		interface OpenApiOperationDoc {
			readonly "x-forge-skip"?: boolean
			readonly "x-forge-group-name"?: string
			readonly "x-forge-method-name"?: string
			readonly "x-checkfu-endpoint"?: {
				readonly group?: string
				readonly endpoint?: string
			}
		}
		const openApiJson = exportDeterministicOpenApiJson()
		const openApiDoc = JSON.parse(openApiJson) as {
			readonly paths: Readonly<Record<string, Readonly<Record<string, OpenApiOperationDoc>>>>
		}
		const HTTP_METHODS = new Set([
			"get",
			"post",
			"put",
			"patch",
			"delete",
			"head",
			"options",
			"trace",
		])
		const openApiEndpoints: Array<string> = []
		const openApiOperationIds: Array<string> = []
		for (const [_path, pathItem] of Object.entries(openApiDoc.paths)) {
			for (const [httpMethod, rawOp] of Object.entries(pathItem)) {
				if (
					!HTTP_METHODS.has(httpMethod.toLowerCase()) ||
					typeof rawOp !== "object" ||
					rawOp === null
				) {
					continue
				}
				if (rawOp["x-forge-skip"] === true) {
					continue
				}
				const endpointMeta = rawOp["x-checkfu-endpoint"]
				expect(typeof endpointMeta?.group).toBe("string")
				expect(typeof endpointMeta?.endpoint).toBe("string")
				openApiEndpoints.push(`${String(endpointMeta?.group)}.${String(endpointMeta?.endpoint)}`)

				const groupName = rawOp["x-forge-group-name"]
				const methodName = rawOp["x-forge-method-name"]
				expect(typeof groupName).toBe("string")
				expect(typeof methodName).toBe("string")
				openApiOperationIds.push(`${String(groupName)}.${String(methodName)}`)
			}
		}
		const sortUnique = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
			[...new Set(values)].sort()

		const expectedEndpoints = sortUnique(openApiEndpoints)
		const expectedOperationIds = sortUnique(openApiOperationIds)
		expect(expectedEndpoints.length).toBeGreaterThan(0)
		expect(expectedEndpoints.length).toBe(openApiEndpoints.length)
		expect(expectedOperationIds.length).toBe(openApiOperationIds.length)

		using forge = parse(openApiJson)
		const catalog = buildSurfaceCatalog(forge)
		const cliCommands = generateCliFiles(forge).find((f) => f.path === "Commands.ts")?.content ?? ""
		const sdkFiles = generateSdkFiles(forge)
		const sdkResources = sdkFiles.find((f) => f.path === "Resources.ts")?.content ?? ""
		const sdkBindings = sdkFiles.find((f) => f.path === "OperationBindings.ts")?.content ?? ""

		const safety = (group: string, endpoint: string) =>
			catalog.operations.find((op) => op.apiGroup === group && op.apiEndpoint === endpoint)
				?.retrySafety
		expect(safety("memory_stores", "deleteMemory")).toBe("pre-commit-only")
		expect(safety("memory_stores", "delete")).toBe("idempotent")

		expect(sortUnique(catalog.operations.map((op) => `${op.apiGroup}.${op.apiEndpoint}`))).toEqual(
			expectedEndpoints,
		)
		expect(sortUnique(catalog.operations.map((op) => op.operationId))).toEqual(expectedOperationIds)

		const bindingOperationIds = Array.from(
			sdkBindings.matchAll(/operationId:\s*"([^"]+)"/g),
			(m) => m[1] ?? "",
		)
		expect(sortUnique(bindingOperationIds)).toEqual(expectedOperationIds)
		expect(bindingOperationIds.length).toBe(expectedOperationIds.length)

		const resourceOperationIds = Array.from(
			sdkResources.matchAll(/readonly\s+"([^"]+)":\s*OperationShape</g),
			(m) => m[1] ?? "",
		)
		expect(sortUnique(resourceOperationIds)).toEqual(expectedOperationIds)
		expect(resourceOperationIds.length).toBe(expectedOperationIds.length)

		const cliEndpoints = Array.from(
			cliCommands.matchAll(/apiGroup:\s*"([^"]+)",\s*\n\s*apiEndpoint:\s*"([^"]+)"/g),
			(m) => `${m[1] ?? ""}.${m[2] ?? ""}`,
		)
		expect(sortUnique(cliEndpoints)).toEqual(expectedEndpoints)
		expect(cliEndpoints.length).toBe(expectedEndpoints.length)

		expect(sdkResources).not.toMatch(/from\s+["']\.{1,2}\/[^"']+\.js["']/)
		expect(cliCommands).not.toMatch(/from\s+["']\.{1,2}\/[^"']+\.js["']/)
		expect(sdkResources).toContain('from "../Runtime.ts"')
		expect(sdkResources).toContain('from "../PromiseRuntime.ts"')
		expect(cliCommands).toContain('from "../GeneratedRuntime.ts"')

		expect(sdkResources).not.toContain("beta")
		expect(sdkBindings).not.toContain("beta")

		for (const op of catalog.operations) {
			expect(cliCommands).toContain(`cliLabel: ${JSON.stringify(op.cliCommand)}`)
			expect(sdkBindings).toContain(`cliCommand: ${JSON.stringify(op.cliCommand)}`)
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
		expect(inspectedMethods.length).toBe(79)

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
