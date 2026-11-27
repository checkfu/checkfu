import { expect, it } from "vitest"
import type { ApiCaller } from "../../src/Api.ts"
import { startAlchemyDev } from "./WorkerdStack.ts"

const denied = (role: ApiCaller) => {
	const message: unknown = expect.stringContaining(`Only the ${role} Worker may make this call.`)
	return { ok: false, message }
}

it("allows only the role assigned to the Worker service binding", async () => {
	const unusedProvider = "http://127.0.0.1:1"
	const worker = await startAlchemyDev(unusedProvider, unusedProvider, undefined, {
		fixture: {
			config: "apps/api/test/workerd/ApiRoles.stack.ts",
			stack: "ApiRoles",
			worker: "ApiRoleCaller",
		},
	})
	try {
		const response = await fetch(`${worker.baseUrl}/roles`)
		expect(response.status).toBe(200)
		expect(await response.json()).toMatchObject({
			harnessCredential: { ok: true, value: "held" },
			harnessPublication: denied("content"),
			contentCredential: denied("harness"),
			contentPublication: { ok: true, value: null },
			plainCredential: denied("harness"),
			plainPublication: denied("content"),
		})
	} finally {
		await worker.stop()
	}
}, 120_000)
