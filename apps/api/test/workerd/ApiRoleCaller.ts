import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Effect from "effect/Effect"
import * as Struct from "effect/Struct"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { bindApiAs } from "../../src/Api.ts"
import { COMPATIBILITY_DATE } from "../../src/Compatibility.ts"
import { ApiRoleTarget } from "./ApiRoleTarget.ts"
import type { RoleProbe } from "./ApiRoleTarget.ts"

export class ApiRoleCaller extends Cloudflare.Worker<ApiRoleCaller, Record<never, never>>()(
	"ApiRoleCaller",
) {}

const client = (name: "ContentApi" | "PlainApi") =>
	Cloudflare.Workers.makeRpcStub<RoleProbe>(
		Effect.map(Cloudflare.Workers.WorkerEnvironment, Struct.get(name)),
	)

const probe = <A, E extends Error, R>(call: Effect.Effect<A, E, R>) =>
	Effect.match(call, {
		onSuccess: (value) => ({ ok: true, value }),
		onFailure: (error) => ({ ok: false, message: error.message }),
	})

export default ApiRoleCaller.make(
	{ main: import.meta.url, compatibility: { date: COMPATIBILITY_DATE } },
	Effect.gen(function* () {
		const worker = yield* Cloudflare.Worker
		const harness = yield* bindApiAs("harness", ApiRoleTarget)
		const target = yield* ApiRoleTarget
		yield* worker.bind`role probes for ${target}`({
			bindings: [
				{
					type: "service",
					name: "ContentApi",
					service: target.workerName,
					props: { caller: "content" },
				},
				{ type: "service", name: "PlainApi", service: target.workerName },
			],
		})
		const content = client("ContentApi")
		const plain = client("PlainApi")
		return {
			fetch: Effect.gen(function* () {
				const request = yield* HttpServerRequest.HttpServerRequest
				if (new URL(request.url, "http://fixture.test").pathname === "/health") {
					return HttpServerResponse.empty({ status: 200 })
				}
				return HttpServerResponse.jsonUnsafe({
					harnessCredential: yield* probe(harness.credentialAccess("vault", "credential")),
					harnessPublication: yield* probe(harness.resolvePublication("page")),
					contentCredential: yield* probe(content.credentialAccess("vault", "credential")),
					contentPublication: yield* probe(content.resolvePublication("page")),
					plainCredential: yield* probe(plain.credentialAccess("vault", "credential")),
					plainPublication: yield* probe(plain.resolvePublication("page")),
				})
			}),
		}
	}),
)
