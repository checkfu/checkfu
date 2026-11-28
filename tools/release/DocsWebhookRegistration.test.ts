import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"

const fixture = String.raw`import assert from "node:assert/strict"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { register } from "./registration.ts"

const url = "https://hooks.example.com/checkfu"
const key = "stable-key"
const confidential = "whsec_fixture_secret"
const id = "whe_test"
const receipt = { id, type: "webhook", pending: true, signing_secret: confidential }
const current = { id, type: "webhook", secret_revision: 1 }
const fixture = async (scenario: "ready" | "pending" | "rotated") => {
	const path = "private/" + scenario + ".json"
	let creates = 0
	let reads = 0
	let unavailable = scenario === "pending"
	const client = {
		webhooks: {
			create: async (_body, options) => {
				creates += 1
				assert.equal(options.idempotencyKey, key)
				return scenario === "ready" ? { ...current, signing_secret: confidential } : receipt
			},
			list: async (query) => {
				reads += 1
				assert.deepEqual(query, { id, limit: 1 })
				assert.equal(JSON.parse(await readFile(path, "utf8")).signing_secret, confidential)
				if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600)
				if (unavailable) return { data: [], next_page: null }
				return { data: [scenario === "rotated" ? { ...current, secret_revision: 2 } : current], next_page: null }
			},
		},
	}

	assert.match((await register(client, url, key, path)).next, {
		ready: /Configure/,
		pending: /check visibility/,
		rotated: /revision has moved/,
	}[scenario])
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { id, key, url, secret_revision: 1, signing_secret: confidential })
	assert.equal(creates, 1)
	assert.equal(reads, 1)
	const rechecked = await register(client, url, key, path)
	assert.equal(rechecked.id, id)
	if (scenario === "pending") {
		assert.match(rechecked.next, /check visibility/)
		unavailable = false
		assert.match((await register(client, url, key, path)).next, /Configure/)
	}
	await assert.rejects(register(client, url, "other", path), /another registration/)
	assert.equal(creates, 1)
	assert.equal(reads, scenario === "pending" ? 3 : 2)
}
for (const scenario of ["ready", "pending", "rotated"] as const) await fixture(scenario)
const path = "private/already-written.json"
await mkdir(dirname(path), { recursive: true })
await assert.rejects(register({
	webhooks: {
		create: async () => {
			await writeFile(path, "other owner's file", { flag: "wx" })
			return receipt
		},
	},
}, url, key, path), /Could not save the receipt for whe_test/)
assert.equal(await readFile(path, "utf8"), "other owner's file")
`

it("saves signing material from the published example before reading registration status", () => {
	const guide = readFileSync(
		new URL("../../apps/docs/concepts/webhooks.mdx", import.meta.url),
		"utf8",
	)
	const source = guide.split("```ts registration.ts\n")[1]?.split("\n```")[0]
	expect(source).toBeTypeOf("string")
	const directory = mkdtempSync(join(tmpdir(), "checkfu-webhook-registration-"))
	try {
		symlinkSync(
			join(import.meta.dirname, "node_modules"),
			join(directory, "node_modules"),
			"junction",
		)
		writeFileSync(join(directory, "registration.ts"), source ?? "")
		writeFileSync(join(directory, "verify.ts"), fixture)
		const result = spawnSync("bun", [join(directory, "verify.ts")], {
			cwd: directory,
			encoding: "utf8",
		})
		expect(result.error).toBeUndefined()
		expect(result.status, result.stderr).toBe(0)
		expect(result.stdout + result.stderr).not.toContain("whsec_fixture_secret")
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
})
