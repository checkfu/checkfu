import { expect, it } from "vitest"
import { MAX_TOOL_ARTIFACT_FILES } from "../../src/Workspace/SessionArtifactTool.ts"
import { MAX_OUTPUT_ENTRIES } from "../../src/Workspace/SessionOutputs.ts"
import type { StoredCaptureSample } from "./StoredCaptureFixture.ts"
import { parseResponseJson, startAlchemyDev } from "./WorkerdStack.ts"

it.runIf(process.env.CHECKFU_MEASURE_STORED_CAPTURE === "1")(
	"measures stored capture enumeration and the provider's pending row overhead",
	async () => {
		const localOnly = "http://127.0.0.1:1"
		const worker = await startAlchemyDev(localOnly, localOnly, undefined, {
			fixture: {
				config: "apps/api/test/workerd/StoredCaptureFixture.stack.ts",
				stack: "StoredCaptureFixture",
				worker: "StoredCaptureTestWorker",
			},
		})
		try {
			const limits = [MAX_OUTPUT_ENTRIES + 1, 8 * MAX_TOOL_ARTIFACT_FILES + 1]
			for (const [budget, limit] of limits.entries()) {
				const sample = async (scale: number, pending = 0) => {
					const width = Math.floor(limit * scale)
					const path = `/${budget}/${width}/${pending}`
					const response = await fetch(`${worker.baseUrl}${path}`, {
						signal: AbortSignal.timeout(90_000),
					})
					const raw = await response.text()
					expect(response.status, raw).toBe(200)
					const measured = parseResponseJson<StoredCaptureSample>("GET", path, response.status, raw)
					process.stdout.write(`${JSON.stringify({ limit, ...measured })}\n`)
					expect(measured.baseline.fetchedRows).toBe(width + 5)
					expect(measured.baseline.count).toBe(Math.min(width + 5 + pending, limit))
					expect(measured.baseline.stats).toBeLessThanOrEqual(limit + 1)
					expect(measured.paged.count).toBe(Math.min(width + 4 + pending, limit))
					expect(measured.paged.fetchedRows).toBe(Math.min(width + 4, limit + pending * 2))
					return measured
				}
				const narrow = await sample(0.5)
				const wide = await sample(2)
				const larger = await sample(8)
				expect(narrow.first).toEqual([
					{ path: "a-directory", type: "dir", size: 0 },
					{ path: "a-directory/inside", type: "file", size: 6 },
					{ path: "b-hard-link-target", type: "other", size: 4 },
					{ path: "c-hard-link", type: "other", size: 4 },
					{ path: "d-symlink", type: "symlink", size: 0 },
				])
				expect(wide.first).toEqual(narrow.first)
				expect(larger.first).toEqual(wide.first)
				if (budget !== 0) {
					continue
				}
				const roomForPending = await sample(0.5, 32)
				expect(roomForPending.baseline.pending).toBe(32)
				expect(roomForPending.last).toEqual({ path: "aa-pending-031", type: "file", size: 7 })
				for (const pending of [32, 128]) {
					const dirty = await sample(2, pending)
					expect(dirty.baseline.pending).toBe(0)
					expect(dirty.paged.first).toEqual(["a-directory", "aa-pending-000"])
				}
			}
		} finally {
			await worker.stop()
		}
	},
	360_000,
)
