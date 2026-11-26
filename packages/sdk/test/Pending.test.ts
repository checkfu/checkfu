import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as OpenApi from "effect/http-api/OpenApi"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { PendingArtifactVersion, PendingCredential, PendingWebhook } from "../src/Api.ts"
import type { PendingResourceType, PendingVault, VaultCredential } from "../src/Api.ts"
import type { CheckfuSdkClient, PendingResolvedResource } from "../src/Client.ts"
import type { CheckfuSdkError } from "../src/Errors.ts"
import { Checkfu, CheckfuApi, CheckfuClient } from "../src/index.ts"

const PendingReceipt = Schema.Struct({
	responses: Schema.Struct({
		"202": Schema.Struct({
			content: Schema.Struct({
				"application/json": Schema.Struct({
					schema: Schema.Struct({
						properties: Schema.Struct({
							type: Schema.Struct({ enum: Schema.Tuple([Schema.String]) }),
							pending: Schema.Struct({ enum: Schema.Tuple([Schema.Literal(true)]) }),
						}),
					}),
				}),
			}),
		}),
	}),
})
const contractReceiptTypes = (): ReadonlyArray<string> => {
	const types = new Set<string>()
	for (const path of Object.values(OpenApi.fromApi(CheckfuApi, {}).paths)) {
		for (const operation of Object.values(path)) {
			const receipt = Schema.decodeUnknownOption(PendingReceipt)(operation)
			if (Option.isSome(receipt)) {
				types.add(
					receipt.value.responses["202"].content["application/json"].schema.properties.type.enum[0],
				)
			}
		}
	}
	return Array.from(types)
}

const poll = {
	until: () => true,
	timeout: "2 seconds",
	initialDelay: "1 millis",
	requestOptions: { maxRetries: 0 },
} as const

const memoryReceipt = {
	id: "res_1",
	type: "memory",
	memory_store_id: "store_1",
	pending: true,
} as const
const credentialReceipt = Schema.decodeSync(PendingCredential)({
	id: "res_1",
	type: "vault_credential",
	vault_id: "vault_1",
	pending: true,
})

const versionReceipt = Schema.decodeSync(PendingArtifactVersion)({
	id: "res_1",
	type: "artifact_version",
	version: 2,
	pending: true,
})

const webhookReceipt = Schema.decodeSync(PendingWebhook)({
	id: "whe_1",
	type: "webhook",
	pending: true,
	signing_secret: "whsec_test_secret",
})

interface Helper {
	readonly reads: string
	readonly effect: (
		client: CheckfuSdkClient,
	) => Effect.Effect<PendingResolvedResource, CheckfuSdkError>
	readonly promise: (client: Checkfu) => Promise<{ readonly type: string }>
}

const helpers = {
	agent: {
		reads: "/v1/agents/res_1",
		effect: (client) => client.waitForPending({ id: "res_1", type: "agent", pending: true }, poll),
		promise: (client) => client.waitForPending({ id: "res_1", type: "agent", pending: true }, poll),
	},
	environment: {
		reads: "/v1/environments/res_1",
		effect: (client) =>
			client.waitForPending({ id: "res_1", type: "environment", pending: true }, poll),
		promise: (client) =>
			client.waitForPending({ id: "res_1", type: "environment", pending: true }, poll),
	},
	session: {
		reads: "/v1/sessions/res_1",
		effect: (client) =>
			client.waitForPending({ id: "res_1", type: "session", pending: true }, poll),
		promise: (client) =>
			client.waitForPending({ id: "res_1", type: "session", pending: true }, poll),
	},
	automation: {
		reads: "/v1/automations/res_1",
		effect: (client) =>
			client.waitForPending({ id: "res_1", type: "automation", pending: true }, poll),
		promise: (client) =>
			client.waitForPending({ id: "res_1", type: "automation", pending: true }, poll),
	},
	artifact: {
		reads: "/v1/artifacts/res_1",
		effect: (client) =>
			client.waitForPending({ id: "res_1", type: "artifact", pending: true }, poll),
		promise: (client) =>
			client.waitForPending({ id: "res_1", type: "artifact", pending: true }, poll),
	},
	artifact_version: {
		reads: "/v1/artifacts/res_1/versions/2",
		effect: (client) => client.waitForPending(versionReceipt, poll),
		promise: (client) => client.waitForPending(versionReceipt, poll),
	},
	vault: {
		reads: "/v1/vaults/res_1",
		effect: (client) => client.waitForPending({ id: "res_1", type: "vault", pending: true }, poll),
		promise: (client) => client.waitForPending({ id: "res_1", type: "vault", pending: true }, poll),
	},
	vault_credential: {
		reads: "/v1/vaults/vault_1/credentials/res_1",
		effect: (client) => client.waitForPending(credentialReceipt, poll),
		promise: (client) => client.waitForPending(credentialReceipt, poll),
	},
	webhook: {
		reads: "/v1/webhooks",
		effect: (client) => client.waitForPending(webhookReceipt, poll),
		promise: (client) => client.waitForPending(webhookReceipt, poll),
	},
	memory_store: {
		reads: "/v1/memory_stores/res_1",
		effect: (client) =>
			client.waitForPending({ id: "res_1", type: "memory_store", pending: true }, poll),
		promise: (client) =>
			client.waitForPending({ id: "res_1", type: "memory_store", pending: true }, poll),
	},
	memory: {
		reads: "/v1/memory_stores/store_1/memories/res_1",
		effect: (client) => client.waitForPending(memoryReceipt, poll),
		promise: (client) => client.waitForPending(memoryReceipt, poll),
	},
} satisfies { readonly [K in PendingResourceType]: Helper }

const recordingFetch =
	(seen: Array<string>): typeof globalThis.fetch =>
	async (input, init) => {
		const request = new Request(input, init)
		seen.push(`${request.method} ${new URL(request.url).pathname}`)
		return new Response(
			JSON.stringify({
				type: "error",
				error: { type: "invalid_request_error", message: "stop here" },
				request_id: "req_1",
			}),
			{ status: 400, headers: { "content-type": "application/json" } },
		)
	}

describe("waitForPending", () => {
	it("reads the resource behind every kind of receipt the contract returns", async () => {
		const types = contractReceiptTypes()
		expect(types.length).toBeGreaterThan(0)
		for (const type of types) {
			const helper: Helper | undefined = Object.entries(helpers).find(
				([kind]) => kind === type,
			)?.[1]
			expect(helper, `no waitForPending support for pending ${type}`).toBeDefined()
			if (helper === undefined) {
				continue
			}
			const viaEffect: Array<string> = []
			await Effect.runPromise(
				Effect.flatMap(CheckfuClient, helper.effect).pipe(
					Effect.flip,
					Effect.provide(
						CheckfuClient.layerFetch({
							apiKey: "ck_test_key",
							baseUrl: "http://localhost:1337",
							maxRetries: 0,
							fetch: recordingFetch(viaEffect),
						}),
					),
				),
			)
			expect(viaEffect, type).toEqual([`GET ${helper.reads}`])

			const viaPromise: Array<string> = []
			const client = new Checkfu({
				apiKey: "ck_test_key",
				baseUrl: "http://localhost:1337",
				maxRetries: 0,
				fetch: recordingFetch(viaPromise),
			})
			try {
				await expect(helper.promise(client)).rejects.toThrow("stop here")
			} finally {
				await client.close()
			}
			expect(viaPromise, type).toEqual([`GET ${helper.reads}`])
		}
	})

	it("returns the resource type the receipt names", () => {
		const effectTypes = (
			client: CheckfuSdkClient,
			credential: VaultCredential | PendingCredential,
		) => {
			const settled: Effect.Effect<VaultCredential, CheckfuSdkError> =
				client.waitForPending(credential)
			return settled
		}
		const promiseTypes = (client: Checkfu, vault: PendingVault) => {
			const settled: Promise<{ readonly type: "vault" }> = client.waitForPending(vault)
			return settled
		}
		expect([typeof effectTypes, typeof promiseTypes]).toEqual(["function", "function"])
	})

	it("takes what the promise client's credential mutations return", () => {
		const archived = async (client: Checkfu) => {
			const receipt = await client.vaults.credentials.archive("vlt_1", "vcrd_1")
			const settled: Promise<{ readonly type: "vault_credential"; readonly vault_id: string }> =
				client.waitForPending(receipt)
			return settled
		}
		const created = async (client: Checkfu) => {
			const receipt = await client.vaults.credentials.create("vlt_1", {
				auth: {
					type: "static_bearer",
					token: Redacted.make("tok_test_value"),
					mcp_server_url: "https://mcp.example/mcp",
				},
			})
			const settled: Promise<{ readonly type: "vault_credential"; readonly custody: string }> =
				client.waitForPending(receipt)
			return settled
		}
		expect([typeof archived, typeof created]).toEqual(["function", "function"])
	})

	it("polls pending webhook registration by ID and refuses to pair signing_secret with a rotated revision", async () => {
		const seenUrls: Array<string> = []
		let attempt = 0
		const webhookRow = (secretRevision: number) => ({
			id: "whe_1",
			type: "webhook",
			status: "active",
			url: "https://hooks.example.com/events",
			description: "Primary",
			event_types: ["*"],
			definition_revision: 1,
			secret_revision: secretRevision,
			previous_secret_expires_at: null,
			consecutive_failures: 0,
			last_failure_at: null,
			created_at: "2026-01-01T00:00:00.000Z",
			updated_at: "2026-01-01T00:00:00.000Z",
		})

		const listingFetch: typeof globalThis.fetch = async (input, init) => {
			const req = new Request(input, init)
			const parsed = new URL(req.url)
			seenUrls.push(`${parsed.pathname}${parsed.search}`)
			attempt += 1
			return new Response(
				JSON.stringify({
					data: attempt === 1 ? [] : [webhookRow(1)],
					next_page: null,
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			)
		}

		const resolved = await Effect.runPromise(
			Effect.flatMap(CheckfuClient, (client) =>
				client.waitForPending(webhookReceipt, {
					until: () => true,
					timeout: "2 seconds",
					initialDelay: "1 millis",
					requestOptions: { maxRetries: 0 },
				}),
			).pipe(
				Effect.provide(
					CheckfuClient.layerFetch({
						apiKey: "ck_test_key",
						baseUrl: "http://localhost:1337",
						maxRetries: 0,
						fetch: listingFetch,
					}),
				),
			),
		)
		expect(seenUrls).toEqual(["/v1/webhooks?limit=1&id=whe_1", "/v1/webhooks?limit=1&id=whe_1"])
		expect(resolved.id).toBe("whe_1")
		expect(resolved.secret_revision).toBe(1)
		expect(resolved.signing_secret).toBe("whsec_test_secret")

		// If rotated to revision 2 before waitForPending resolves, fail immediately with ConflictError.
		let rotatedCalls = 0
		const rotatedFetch: typeof globalThis.fetch = async () => {
			rotatedCalls += 1
			return new Response(
				JSON.stringify({
					data: [webhookRow(2)],
					next_page: null,
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			)
		}
		const conflict = await Effect.runPromise(
			Effect.flatMap(CheckfuClient, (client) =>
				client.waitForPending(webhookReceipt, {
					until: () => true,
					timeout: "2 seconds",
					initialDelay: "1 millis",
					requestOptions: { maxRetries: 0 },
				}),
			).pipe(
				Effect.flip,
				Effect.provide(
					CheckfuClient.layerFetch({
						apiKey: "ck_test_key",
						baseUrl: "http://localhost:1337",
						maxRetries: 0,
						fetch: rotatedFetch,
					}),
				),
			),
		)
		expect(conflict._tag).toBe("ConflictError")
		expect(rotatedCalls).toBe(1)
	})
})
