import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { sandboxesContract } from "../SandboxesContract.ts"
import { parseResponseJson, startAlchemyDev, waitForDocker } from "./WorkerdStack.ts"

const UNUSED_PROVIDER = "http://127.0.0.1:1"

describe("the Cloudflare sandbox layer keeps the sandbox contract", () => {
	let worker: Awaited<ReturnType<typeof startAlchemyDev>> | undefined

	beforeAll(async () => {
		await waitForDocker()
		worker = await startAlchemyDev(UNUSED_PROVIDER, UNUSED_PROVIDER, undefined, {
			fixture: {
				config: "apps/api/test/workerd/SandboxesFixture.stack.ts",
				stack: "SandboxesFixture",
				worker: "SandboxesTestWorker",
			},
		})
	}, 300_000)

	afterAll(async () => {
		await worker?.stop()
	}, 60_000)

	it.each(sandboxesContract.map((clause, index) => ({ name: clause.name, index })))(
		"$name",
		async ({ index }) => {
			if (worker === undefined) {
				throw new Error("The fixture did not start.")
			}
			const path = `/contract/${index}/contract-${index}-${Date.now().toString(36)}`
			const response = await fetch(`${worker.baseUrl}${path}`)
			const raw = await response.text()
			expect(response.status, raw).toBe(200)
			expect(parseResponseJson("GET", path, response.status, raw)).toEqual({ ok: true })
		},
		120_000,
	)
})
