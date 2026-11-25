import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Clock from "effect/Clock"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Redacted from "effect/Redacted"
import { COMPATIBILITY_DATE } from "../src/Compatibility.ts"
import { SandboxesCloudflare } from "../src/Sandbox/CloudflareSandboxes.do.ts"
import { Sandboxes } from "../src/Sandbox/Sandboxes.ts"
import type { ExecResult } from "../src/Sandbox/Sandboxes.ts"

// A spike, not part of the product: one request runs a sandbox through its whole life and
// reports how long each step took.

export class SandboxSpikeWorker extends Cloudflare.Worker<
	SandboxSpikeWorker,
	Record<never, never>
>()("SandboxSpikeWorker") {}

const FILE = "/workspace/notes/a.txt"

type Shown = string | number | ExecResult

interface Step {
	readonly step: string
	readonly ms: number
	readonly result?: Shown
}

export default SandboxSpikeWorker.make(
	{ main: import.meta.url, compatibility: { date: COMPATIBILITY_DATE }, dev: { port: 1390 } },
	Effect.gen(function* () {
		const sandboxes = yield* Sandboxes
		const ctx = yield* Cloudflare.WorkerExecutionContext
		// The spike runs commands for whoever asks, so a deployed one answers only its deployer.
		const token = Redacted.value(yield* Config.Redacted("SPIKE_TOKEN"))
		const steps = (key: string) =>
			Effect.gen(function* () {
				const report: Array<Step> = []
				const timed = <A, E>(step: string, effect: Effect.Effect<A, E>, show?: (a: A) => Shown) =>
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
					"exec reaching a host not allowed",
					cold.exec([
						"node",
						"-e",
						"fetch('https://example.org').then(r=>console.log(r.status),e=>console.log('blocked:',e.cause?.code??e.message))",
					]),
					(r) => r,
				)
				yield* timed(
					"exec reaching an allowed host",
					cold.exec([
						"node",
						"-e",
						"fetch('https://example.com/acme/api.git/info/refs',{headers:{authorization:'Bearer from-the-sandbox'}}).then(async r=>console.log(r.status,await r.text()),e=>console.log('blocked:',e.cause?.code??e.message))",
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
				// A sandbox's HTTPS to an allowed host arrives here, named by the sandbox it came from.
				const { sandbox } = yield* ctx.props
				if (typeof sandbox === "string") {
					return HttpServerResponse.text(
						`egress of ${sandbox}: ${request.method} ${request.url}; the sandbox sent authorization=${request.headers["authorization"] ?? "none"}; the Worker would replace it with the stored token`,
					)
				}
				if (token.length < 32 || request.headers["x-spike-token"] !== token) {
					return HttpServerResponse.empty({ status: 404 })
				}
				const params = new URL(request.url, "http://spike").searchParams
				const key = params.get("key") ?? "spike"
				const op = params.get("op")
				if (op === "suspend" || op === "remove" || op === "open") {
					const from = yield* Clock.currentTimeMillis
					const done = yield* Effect.result(
						op === "open" ? Effect.asVoid(sandboxes.open(key)) : sandboxes[op](key),
					)
					return yield* HttpServerResponse.json(
						done._tag === "Success"
							? { op, ms: (yield* Clock.currentTimeMillis) - from }
							: { op, error: done.failure.message },
					)
				}
				const cmd = params.get("cmd")
				if (cmd !== null) {
					const ran = yield* Effect.result(
						Effect.flatMap(sandboxes.open(key), (sandbox) => sandbox.exec(cmd)),
					)
					return yield* HttpServerResponse.json(
						ran._tag === "Success" ? ran.success : { error: ran.failure.message },
					)
				}
				const outcome = yield* Effect.result(steps(key))
				return yield* HttpServerResponse.json(
					outcome._tag === "Success"
						? { ok: true, steps: outcome.success }
						: { ok: false, error: outcome.failure.message },
				)
			}).pipe(Effect.orDie),
		}
	}).pipe(Effect.provide(SandboxesCloudflare({ egress: ["example.com"] }))),
)
