import { expect, it } from "vitest"
import type { ApiCaller, ApiShape } from "../../src/Api.ts"
import type { ApiRoleProbeResult } from "./ApiRoleCaller.ts"
import { AUTH_HEADERS, startAlchemyDev } from "./WorkerdStack.ts"

const denied = (role: ApiCaller) => {
	const message: unknown = expect.stringContaining(`Only the ${role} Worker may make this call.`)
	return { ok: false, message }
}

const readOnly = { ok: false, code: "EROFS", message: "No memory store is mounted as role-probe." }
const idle = { ok: false, message: "The turn is no longer running." }
const expected = {
	credentialAccess: ["harness", "ended"],
	resolveArtifactVersion: ["content", null],
	resolvePublication: ["content", null],
	artifactData: ["content", { status: 404, body: '{"error":{"message":"Not found."}}' }],
	memoryMounts: ["harness", []],
	memoryList: ["harness", []],
	memoryStat: ["harness", null],
	memoryRead: ["harness", null],
	memoryWrite: ["harness", readOnly],
	memoryRemove: ["harness", readOnly],
	artifactMounts: ["harness", []],
	artifactFiles: ["harness", []],
	artifactRead: ["harness", null],
	sessionFileSave: ["harness", idle],
	sessionArtifactSave: ["harness", idle],
	sessionArtifactData: ["harness", idle],
} as const satisfies Record<keyof ApiShape, readonly [ApiCaller, unknown]>

it("enforces roles across the production API Worker RPC methods", async () => {
	const unusedProvider = "http://127.0.0.1:1"
	const worker = await startAlchemyDev(unusedProvider, unusedProvider, undefined, {
		fixture: {
			config: "apps/api/test/workerd/ApiRoles.stack.ts",
			stack: "ApiRoles",
			worker: "ApiRoleCaller",
		},
	})
	try {
		const agents = `${worker.baseUrl}/v1/agents`
		expect((await fetch(agents)).status).toBe(401)
		const authenticated = await fetch(agents, { headers: AUTH_HEADERS })
		expect(authenticated.status).toBe(200)
		expect(await authenticated.json()).toMatchObject({ data: [] })
		const create = async (path: string, body: Readonly<Record<string, string>>) => {
			const response = await fetch(`${worker.baseUrl}/v1/${path}`, {
				method: "POST",
				headers: { ...AUTH_HEADERS, "content-type": "application/json" },
				body: JSON.stringify(body),
			})
			expect([201, 202]).toContain(response.status)
			return (await response.json()) as { readonly id: string }
		}
		const agent = await create("agents", { name: "Probe", model: "gpt-4o-mini" })
		const env = await create("environments", { name: "Probe" })
		const session = await create("sessions", { agent: agent.id, environment_id: env.id })
		const response = await fetch(`${worker.baseUrl}/roles?session_id=${session.id}`)
		expect(response.status).toBe(200)
		const matrix = (await response.json()) as Record<
			ApiCaller | "plain",
			Record<string, ApiRoleProbeResult>
		>
		for (const [method, [role, value]] of Object.entries(expected)) {
			for (const caller of ["harness", "content", "plain"] as const) {
				expect(matrix[caller][method], `${caller} calls ${method}`).toEqual(
					caller === role ? { ok: true, value } : denied(role),
				)
			}
		}
	} finally {
		await worker.stop()
	}
}, 120_000)
