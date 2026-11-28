import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"

const fixture = String.raw`import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"
import { createReceiver, decodeSigningKey } from "./receiver.ts"

const bytes = Buffer.alloc(32, 97)
const key = decodeSigningKey("whsec_" + bytes.toString("base64"))
assert.deepEqual(key, bytes)
for (const value of ["whsec_...", "whsec_", "invalid", "whsec_" + bytes.toString("base64") + "!"])
	assert.throws(() => decodeSigningKey(value), /complete signing secret/)
let now = 1_700_000_000_000
const sign = (id: string, type: string) => {
	const body = Buffer.from(JSON.stringify({ data: { type, id: "resource" } }))
	const timestamp = String(now / 1000)
	const signature = createHmac("sha256", key).update(id + "." + timestamp + ".").update(body).digest("base64")
	return [body, { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": "v1," + signature }] as const
}

const completed = Promise.withResolvers<void>()
const started = Promise.withResolvers<void>()
let attempts = 0
const receive = createReceiver(key, async (event) => {
	if (event.data.type !== "session.status_idled") return
	attempts += 1
	if (attempts === 1) {
		started.resolve()
		await completed.promise
	}
}, { now: () => now })

const a = receive(...sign("evt_1", "session.status_idled"))
const b = receive(...sign("evt_1", "session.status_idled"))
let acknowledged = false
void Promise.any([a, b]).then(() => { acknowledged = true })
await started.promise
await Promise.resolve()
assert.equal(attempts, 1)
assert.equal(acknowledged, false)
completed.reject(new Error("hidden raw body"))
assert.deepEqual(await Promise.all([a, b]), [503, 503])
assert.equal(await receive(...sign("evt_1", "session.status_idled")), 204)
assert.equal(await receive(...sign("evt_1", "session.status_idled")), 204)
assert.equal(await receive(...sign("evt_ignored", "future.event")), 204)
assert.equal(attempts, 2)

const [body, headers] = sign("evt_bad", "session.status_idled")
assert.equal(await receive(Buffer.concat([body, Buffer.from(" ")]), headers), 401)
assert.equal(attempts, 2)

now += 14 * 24 * 60 * 60 * 1000 + 1_000
assert.equal(await receive(...sign("evt_1", "session.status_idled")), 204)
assert.equal(attempts, 3)

const timed = createReceiver(key, async (_event, signal) => {
	await sleep(100, undefined, { signal })
}, { now: () => now, timeout: 10 })
assert.equal(await timed(...sign("evt_timeout", "session.status_idled")), 503)
`

it("acknowledges signed deliveries only after the runnable receiver owns the result", () => {
	const guide = readFileSync(
		new URL("../../apps/docs/guides/receive-webhooks.mdx", import.meta.url),
		"utf8",
	)
	const source = guide.split("```ts receiver.ts\n")[1]?.split("\n```")[0]
	expect(source).toBeTypeOf("string")
	const directory = mkdtempSync(join(tmpdir(), "checkfu-webhook-receiver-"))
	try {
		writeFileSync(join(directory, "receiver.ts"), source ?? "")
		writeFileSync(join(directory, "verify.ts"), fixture)
		const result = spawnSync("bun", [join(directory, "verify.ts")], { encoding: "utf8" })
		expect(result.error).toBeUndefined()
		expect(result.status, result.stderr).toBe(0)
		expect(result.stderr).toContain("Could not process webhook evt_1")
		expect(result.stderr).toContain("Could not process webhook evt_timeout")
		expect(result.stderr).not.toContain("hidden raw body")
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
})
