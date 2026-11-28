import * as Cloudflare from "@alchemy.run/cloudflare"
import type * as Context from "effect/Context"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { COMPATIBILITY_DATE } from "../../src/Compatibility.ts"
import { placedStub } from "../../src/Placement.ts"
import { MAX_TOOL_ARTIFACT_FILES } from "../../src/Workspace/SessionArtifactTool.ts"
import { MAX_OUTPUT_ENTRIES, makeStoredOutputFiles } from "../../src/Workspace/SessionOutputs.ts"

export const captureLimits = [MAX_OUTPUT_ENTRIES + 1, 8 * MAX_TOOL_ARTIFACT_FILES + 1]

const measure = async (
	storage: Context.Service.Shape<typeof Cloudflare.DurableObjectState>["raw"]["storage"],
	limit: number,
	width: number,
	pending: number,
) => {
	const { Workspace } = await import("@cloudflare/computer")
	let fetchedRows = 0
	let stats = 0
	const workspace = new Workspace({
		storage: {
			sql: {
				exec: (query, ...bindings) => {
					const cursor = storage.sql.exec(query, ...bindings)
					return {
						toArray: () => {
							const rows = cursor.toArray()
							if (query.includes("ORDER BY d.name")) {
								fetchedRows += rows.length
							}
							return rows
						},
					}
				},
			},
			transactionSync: (run) => storage.transactionSync(run),
		},
	})
	const root = "/capture"
	const provider = workspace.provider()
	provider.mkdirSync(root)
	provider.mkdirSync(`${root}/a-directory`)
	provider.writeFileSync(`${root}/a-directory/inside`, "inside")
	provider.writeFileSync(`${root}/b-hard-link-target`, "hard")
	provider.linkSync(`${root}/b-hard-link-target`, `${root}/c-hard-link`)
	provider.symlinkSync("a-directory", `${root}/d-symlink`)
	workspace.db.transactionSync(() => {
		for (let index = 0; index < width; index++) {
			provider.createFileSync(`${root}/file-${String(index).padStart(5, "0")}`)
		}
	})
	for (let index = 0; index < pending; index++) {
		const filename = `${root}/aa-pending-${String(index).padStart(3, "0")}`
		provider.openWriteBufferForCreateSync(filename)
		provider.writeRangeSync(filename, "pending", 0)
	}
	const stat = provider.lstatSync.bind(provider)
	provider.lstatSync = (path, options) => {
		stats += 1
		return stat(path, options)
	}
	fetchedRows = 0
	const output = makeStoredOutputFiles(workspace, root)
	const captured = await output.list(limit)
	const baseline = {
		fetchedRows,
		stats,
		count: captured.length,
		pending: captured.filter((entry) => entry.path.startsWith("aa-pending-")).length,
	}
	fetchedRows = 0
	const page = await workspace.fs.readdir(root, { limit, offset: 0 })
	const paged = { fetchedRows, count: page.length, first: page.slice(0, 2).map(({ name }) => name) }
	return { baseline, paged, first: captured.slice(0, 5), last: captured.at(-1), pending, width }
}
export type StoredCaptureSample = Awaited<ReturnType<typeof measure>>

class StoredCaptureFixture extends Cloudflare.DurableObject<StoredCaptureFixture>()(
	"StoredCaptureFixture",
	Effect.map(Cloudflare.DurableObjectState, ({ raw }) =>
		Effect.succeed({
			measure: (limit: number, width: number, pending: number) =>
				Effect.promise(() => measure(raw.storage, limit, width, pending)),
		}),
	),
) {}

export class StoredCaptureTestWorker extends Cloudflare.Worker<
	StoredCaptureTestWorker,
	Record<never, never>
>()("StoredCaptureTestWorker") {}

export default StoredCaptureTestWorker.make(
	{
		main: import.meta.url,
		compatibility: { date: COMPATIBILITY_DATE, flags: ["nodejs_compat"] },
		dev: { port: 17_493 },
	},
	Effect.gen(function* () {
		const fixture = placedStub(yield* StoredCaptureFixture, {})
		return {
			fetch: Effect.gen(function* () {
				const request = yield* HttpServerRequest.HttpServerRequest
				const path = new URL(request.url, "http://fixture.test").pathname
				if (path === "/health") {
					return HttpServerResponse.empty({ status: 200 })
				}
				const [, budget, width, pending] = path.split("/").map(Number)
				const limit = captureLimits[budget ?? -1]
				if (
					limit === undefined ||
					![0.5, 2, 8].some((scale) => width === Math.floor(limit * scale)) ||
					pending === undefined ||
					![0, 32, 128].includes(pending) ||
					width === undefined
				) {
					return HttpServerResponse.empty({ status: 404 })
				}
				return HttpServerResponse.jsonUnsafe(
					yield* fixture(SecureRandom.uuidV4Unsafe()).measure(limit, width, pending),
				)
			}),
		}
	}),
)
