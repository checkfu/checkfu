import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { COMPATIBILITY_DATE } from "../src/Compatibility.ts"
import { SandboxesCloudflare } from "../src/Sandbox/CloudflareSandboxes.do.ts"
import { Sandboxes } from "../src/Sandbox/Sandboxes.ts"

// A spike, not part of the product: one request runs a sandbox through its whole life and
// reports how long each step took.

export class SandboxSpikeWorker extends Cloudflare.Worker<SandboxSpikeWorker>()(
	"SandboxSpikeWorker",
) {}

const FILE = "/workspace/notes/a.txt"

export default SandboxSpikeWorker.make(
	{ main: import.meta.url, compatibility: { date: COMPATIBILITY_DATE }, dev: { port: 1390 } },
	Effect.gen(function* () {
		const sandboxes = yield* Sandboxes
		const steps = (key: string) =>
			Effect.gen(function* () {
				const report: Array<Record<string, unknown>> = []
				const timed = <A, E>(step: string, effect: Effect.Effect<A, E>, show?: (a: A) => unknown) =>
					Effect.gen(function* () {
						const from = yield* Clock.currentTimeMillis
						const value = yield* effect
						report.push({
							step,
							ms: (yield* Clock.currentTimeMillis) - from,
							...(show === undefined ? {} : { result: show(value) }),
						})
						return value
					})
				const cold = yield* timed("open (new)", sandboxes.open(key))
				yield* timed("exec echo", cold.exec("echo hello && uname -srm"), (r) => r)
				yield* timed("writeFile", cold.writeFile(FILE, "kept across a suspend\n"))
				yield* timed(
					"exec with cwd, env and argv",
					cold.exec(["sh", "-c", 'echo "$WHO in $(pwd)"; ls -la'], {
						cwd: "/workspace/notes",
						env: { WHO: "agent" },
					}),
					(r) => r,
				)
				yield* timed("exec that fails", cold.exec("ls /nope"), (r) => r)
				yield* timed("exec past its timeout", cold.exec("sleep 30", { timeout: 1500 }), (r) => r)
				yield* timed(
					"exec with no network",
					cold.exec([
						"node",
						"-e",
						"fetch('https://example.com').then(r=>console.log(r.status),e=>console.log('blocked:',e.cause?.code??e.message))",
					]),
					(r) => r,
				)
				yield* timed(
					"which tools",
					cold.exec("which git rg node npm python3 curl 2>&1; true"),
					(r) => r.stdout,
				)
				yield* timed("suspend (snapshot and stop)", sandboxes.suspend(key))
				const warm = yield* timed("open (restore)", sandboxes.open(key))
				yield* timed("readTextFile after restore", warm.readTextFile(FILE), (text) => text)
				yield* timed("exec after restore", warm.exec("echo back"), (r) => r.stdout)
				yield* timed("suspend again", sandboxes.suspend(key))
				yield* timed("open (second restore)", sandboxes.open(key))
				yield* timed("remove", sandboxes.remove(key))
				const fresh = yield* timed("open (after remove)", sandboxes.open(key))
				yield* timed("file is gone after remove", fresh.exec(`cat ${FILE}`), (r) => r.exitCode)
				yield* timed("remove", sandboxes.remove(key))
				return report
			})
		return {
			fetch: Effect.gen(function* () {
				const request = yield* HttpServerRequest.HttpServerRequest
				const key = new URL(request.url, "http://spike").searchParams.get("key") ?? "spike"
				const outcome = yield* Effect.result(steps(key))
				return yield* HttpServerResponse.json(
					outcome._tag === "Success"
						? { ok: true, steps: outcome.success }
						: { ok: false, error: outcome.failure.message },
				)
			}).pipe(Effect.orDie),
		}
	}).pipe(Effect.provide(SandboxesCloudflare)),
)
