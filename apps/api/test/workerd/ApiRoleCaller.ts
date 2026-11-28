import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Effect from "effect/Effect"
import * as Struct from "effect/Struct"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { ApiWorker, bindApiAs } from "../../src/Api.ts"
import type { ApiShape } from "../../src/Api.ts"
import { COMPATIBILITY_DATE } from "../../src/Compatibility.ts"

export class ApiRoleCaller extends Cloudflare.Worker<ApiRoleCaller, Record<never, never>>()(
	"ApiRoleCaller",
) {}

const client = (name: "ContentApi" | "PlainApi") =>
	Cloudflare.Workers.makeRpcStub<ApiShape>(
		Effect.map(Cloudflare.Workers.WorkerEnvironment, Struct.get(name)),
	)

export type ApiRoleProbeResult =
	| { readonly ok: true; readonly value: unknown }
	| { readonly ok: false; readonly message: string }

const probe = <A, E extends Error, R>(
	call: Effect.Effect<A, E, R>,
): Effect.Effect<ApiRoleProbeResult, never, R> =>
	Effect.match(call, {
		onSuccess: (value) => ({ ok: true, value }),
		onFailure: (error) => ({ ok: false, message: error.message }),
	})

const mount = "/mnt/artifacts/role-probe"
const store = "role-probe"
const path = "/probe.md"
const missingArtifact = "art_00000000000000000000000000000000"

type ApiClient = ReturnType<typeof client>
const probes: Record<
	keyof ApiShape,
	(api: ApiClient, session: string) => Effect.Effect<ApiRoleProbeResult>
> = {
	credentialAccess: (api) => probe(api.credentialAccess("vault_role_probe", "vcrd_role_probe")),
	resolveArtifactVersion: (api) => probe(api.resolveArtifactVersion(missingArtifact, 1)),
	resolvePublication: (api) => probe(api.resolvePublication("role-probe")),
	artifactData: (api) =>
		probe(
			api.artifactData(
				{ kind: "publication", address: "role-probe" },
				{
					operation: "list",
					collection: "notes",
					id: "",
					body: "",
					page: "",
					limit: "",
					idempotency_key: "",
					caller: "role-probe",
				},
			),
		),
	memoryMounts: (api, session) => probe(api.memoryMounts(session)),
	memoryList: (api, session) => probe(api.memoryList(session, store, [])),
	memoryStat: (api, session) => probe(api.memoryStat(session, store, path)),
	memoryRead: (api, session) => probe(api.memoryRead(session, store, path)),
	memoryWrite: (api, session) => probe(api.memoryWrite(session, store, path, "probe", false)),
	memoryRemove: (api, session) => probe(api.memoryRemove(session, store, path, null)),
	artifactMounts: (api, session) => probe(api.artifactMounts(session)),
	artifactFiles: (api, session) => probe(api.artifactFiles(session, mount, null)),
	artifactRead: (api, session) => probe(api.artifactRead(session, mount, "probe.md", 0, 1)),
	sessionFileSave: (api, session) =>
		probe(
			api.sessionFileSave(
				session,
				1,
				{ directory: "/workspace", path: "probe.md" },
				new Uint8Array(),
			),
		),
	sessionArtifactSave: (api, session) =>
		probe(
			api.sessionArtifactSave(
				session,
				1,
				"Probe",
				[{ path: "probe.md", file_id: "file_00000000000000000000000000000000" }],
				"",
			),
		),
	sessionArtifactData: (api, session) =>
		probe(
			api.sessionArtifactData(session, 1, "Probe", {
				operation: "list",
				collection: "notes",
				id: "",
				data: "",
				page: "",
				limit: 0,
				key: "",
			}),
		),
}

const probeAll = (api: ApiClient, session: string) =>
	Effect.map(
		Effect.forEach(Object.entries(probes), ([name, run]) =>
			Effect.map(run(api, session), (result) => [name, result] as const),
		),
		(entries) => Object.fromEntries(entries),
	)

export default ApiRoleCaller.make(
	{ main: import.meta.url, compatibility: { date: COMPATIBILITY_DATE } },
	Effect.gen(function* () {
		const worker = yield* Cloudflare.Worker
		const harness = yield* bindApiAs("harness", ApiWorker)
		const target = yield* ApiWorker
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
				const url = new URL(request.url, "http://fixture.test")
				const { pathname } = url
				if (pathname === "/health") {
					return HttpServerResponse.empty({ status: 200 })
				}
				if (pathname.startsWith("/v1/")) {
					const env = yield* Cloudflare.Workers.WorkerEnvironment
					const binding = env["PlainApi"] as { fetch(request: Request): Promise<Response> }
					const forwarded = yield* HttpServerRequest.toWeb(request)
					const response = yield* Effect.promise(() => binding.fetch(forwarded))
					return HttpServerResponse.fromWeb(response)
				}
				const session = url.searchParams.get("session_id") ?? ""
				return HttpServerResponse.jsonUnsafe({
					harness: yield* probeAll(harness, session),
					content: yield* probeAll(content, session),
					plain: yield* probeAll(plain, session),
				})
			}),
		}
	}),
)
