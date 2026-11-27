import type * as Effect from "effect/Effect"
import { expect, it } from "vitest"
import type { measureStaging } from "./ArtifactStagingMeasurement.ts"
import { parseResponseJson, startAlchemyDev } from "./WorkerdStack.ts"

type Sample = Effect.Success<ReturnType<typeof measureStaging>>

// Existing versions use HEAD to avoid resubmitting file bodies that R2 already has.
// These sequential, fixed-size samples measure local binding calls. Production stages
// verified blobs concurrently, so the elapsed samples describe the fixture only.
it.runIf(process.env.CHECKFU_MEASURE_ARTIFACT_STAGING === "1")(
	"compares HEAD and conditional PUT on local immutable artifact staging",
	async () => {
		const unusedProvider = "http://127.0.0.1:1"
		const worker = await startAlchemyDev(unusedProvider, unusedProvider, undefined, {
			fixture: {
				config: "apps/api/test/workerd/ArtifactMountFixture.stack.ts",
				stack: "ArtifactMountFixture",
				worker: "ArtifactMountTestWorker",
			},
		})
		const get = async <A>(path: string) => {
			const response = await fetch(`${worker.baseUrl}${path}`)
			const raw = await response.text()
			expect(response.status, raw).toBe(200)
			return parseResponseJson<A>("GET", path, response.status, raw)
		}
		try {
			expect(await get("/staging/qualify")).toEqual({
				created: 1,
				refused: 1,
				duplicateRefused: true,
				originalContent: "",
				contentType: "application/octet-stream",
				originalChecksum: true,
				invalidChecksumFailed: "R2Error",
				invalidChecksumStored: false,
			})
			for (const { files, bytes } of [
				{ files: 2, bytes: 2093 },
				{ files: 64, bytes: 66_999 },
			]) {
				for (const distribution of ["cold", "mixed", "warm"]) {
					const existing =
						distribution === "cold" ? 0 : distribution === "warm" ? files + 1 : files / 2
					const created = files + 1 - existing
					const submitted = distribution === "warm" ? 0 : bytes - existing * 1024
					for (let sample = 0; sample < 3; sample++) {
						const head = await get<Sample>(`/staging/${files}/${distribution}/head`)
						const conditional = await get<Sample>(`/staging/${files}/${distribution}/conditional`)
						expect(head).toMatchObject({ heads: files + 1, puts: created, submitted, created })
						expect(conditional).toMatchObject({
							heads: 0,
							puts: files + 1,
							submitted: bytes,
							created,
						})
						process.stdout.write(`${JSON.stringify({ head, conditional })}\n`)
					}
				}
			}
		} finally {
			await worker.stop()
		}
	},
	120_000,
)
