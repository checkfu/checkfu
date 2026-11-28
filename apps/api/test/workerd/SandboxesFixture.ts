import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Effect from "effect/Effect"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { COMPATIBILITY_DATE } from "../../src/Compatibility.ts"
import { SandboxesCloudflare } from "../../src/Sandbox/CloudflareSandboxes.do.ts"
import { Sandboxes } from "../../src/Sandbox/Sandboxes.ts"
import { sandboxesContract } from "../SandboxesContract.ts"

export class SandboxesTestWorker extends Cloudflare.Worker<
	SandboxesTestWorker,
	Record<never, never>
>()("SandboxesTestWorker") {}

export default SandboxesTestWorker.make(
	{ main: import.meta.url, compatibility: { date: COMPATIBILITY_DATE }, dev: { port: 1391 } },
	Effect.gen(function* () {
		const sandboxes = yield* Sandboxes
		const ctx = yield* Cloudflare.WorkerExecutionContext
		return {
			fetch: Effect.gen(function* () {
				const { sandbox } = yield* ctx.props
				if (typeof sandbox === "string") {
					return HttpServerResponse.empty({ status: 403 })
				}
				const request = yield* HttpServerRequest.HttpServerRequest
				const path = new URL(request.url, "http://fixture.test").pathname
				if (path === "/health") {
					return HttpServerResponse.empty({ status: 200 })
				}
				const [, route, index, key, extra] = path.split("/")
				const clause = route === "contract" ? sandboxesContract[Number(index)] : undefined
				if (
					clause === undefined ||
					String(Number(index)) !== index ||
					key === undefined ||
					key === "" ||
					extra !== undefined
				) {
					return HttpServerResponse.empty({ status: 404 })
				}
				return yield* clause.check(key).pipe(
					Effect.provideService(Sandboxes, sandboxes),
					Effect.match({
						onFailure: (error) =>
							HttpServerResponse.jsonUnsafe({
								ok: false,
								error: `${error._tag}: ${error.message}`,
							}),
						onSuccess: () => HttpServerResponse.jsonUnsafe({ ok: true }),
					}),
				)
			}),
		}
	}).pipe(Effect.provide(SandboxesCloudflare)),
)
