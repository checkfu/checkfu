import { describe, expect, it } from "@effect/vitest"
import { Checkfu } from "../src/Checkfu.ts"
import { secret } from "../src/index.ts"

const credential = {
	id: "cred_0123456789abcdef0123456789abcdef",
	type: "vault_credential",
	vault_id: "vlt_0123456789abcdef0123456789abcdef",
	display_name: "GitHub",
	auth: { type: "static_bearer", mcp_server_url: "https://api.githubcopilot.com/mcp/" },
	custody: "held",
	created_at: "2026-11-28T00:00:00.000Z",
	updated_at: "2026-11-28T00:00:00.000Z",
	archived_at: null,
}

describe("secret()", () => {
	it("hides the value when printed", () => {
		const token = secret("ghp_example_token_value")
		expect(String(token)).not.toContain("ghp_example_token_value")
		expect(JSON.stringify({ token })).not.toContain("ghp_example_token_value")
		expect(Checkfu.secret).toBe(secret)
	})

	it("is accepted by secret request fields and sent as a plain JSON string", async () => {
		const bodies: Array<unknown> = []
		const client = new Checkfu({
			apiKey: "ck_test_key",
			baseUrl: "http://localhost:1337",
			maxRetries: 0,
			fetch: async (input, init) => {
				bodies.push(await new Request(input, init).json())
				return Response.json(credential, { status: 201 })
			},
		})
		const created = await client.vaults.credentials.create(credential.vault_id, {
			display_name: "GitHub",
			auth: {
				type: "static_bearer",
				token: secret("ghp_example_token_value"),
				mcp_server_url: "https://api.githubcopilot.com/mcp/",
			},
		})
		expect(bodies[0]).toMatchObject({ auth: { token: "ghp_example_token_value" } })
		expect(created.id).toBe(credential.id)
	})
})
