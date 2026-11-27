import type { JsonObject } from "@earendil-works/pi-durable"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import { vi } from "vitest"
import { recoverPiDurableTurn, runPiDurableTurn } from "../../src/Pi/PiDurableEngine.ts"
import type { PiDurableBackend } from "../../src/Pi/PiDurableEngine.ts"
import type { PiTurnOutcome, PiTurnRequest } from "../../src/Pi/PiTurn.ts"
import type { InMemoryPiDurableBackend } from "./InMemoryPiBackend.ts"

export type WaitPath = "fresh" | "recovery"

export const measurePause = process.env["CHECKFU_MEASURE_PAUSE"] === "1"

export const reportPauseMeasurement = (sample: JsonObject): void => {
	if (measurePause) {
		process.stdout.write(`${JSON.stringify(sample)}\n`)
	}
}

const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout

export const waitForPauseProbe = <A>(result: Promise<A>, phase: string): Promise<A> => {
	const timeout = Promise.withResolvers<never>()
	const timer = realSetTimeout(
		() => timeout.reject(new Error(`Pause measurement timed out ${phase}.`)),
		3000,
	)
	return Promise.race([result, timeout.promise]).finally(() => realClearTimeout(timer))
}

export const observePauseWait = async (
	raw: InMemoryPiDurableBackend,
	path: WaitPath,
	request: PiTurnRequest,
) => {
	const submission = vi.spyOn(raw.storage, "submissionByRequest")
	const inspection = vi.spyOn(await raw.pi(), "inspect")
	const taskScan = vi.spyOn(raw.storage, "scanTasks")
	let waitCalls = 0
	let waitAborts = 0
	let turnAborts = 0
	const stopped = () => {
		waitAborts++
	}
	const counts = () => ({
		waitCalls,
		submissionReads: submission.mock.calls.length,
		inspections: inspection.mock.calls.length,
		taskScans: taskScan.mock.calls.length,
		waitAborts,
		turnAborts,
	})
	let entered = Promise.withResolvers<ReturnType<typeof counts>>()
	const backend: PiDurableBackend = {
		...raw,
		wait: (operationId, signal) => {
			waitCalls++
			signal?.addEventListener("abort", stopped, { once: true })
			const result = raw.wait(operationId, signal)
			entered.resolve(counts())
			return result.finally(() => signal?.removeEventListener("abort", stopped))
		},
		abort: (operationId) =>
			Effect.suspend(() => {
				turnAborts++
				return raw.abort(operationId)
			}),
	}
	const waitEntered = (fiber: Fiber.Fiber<PiTurnOutcome | null>) =>
		waitForPauseProbe(
			Promise.race([
				entered.promise,
				Effect.runPromise(Fiber.await(fiber)).then((exit) => {
					throw new Error("The observed turn finished before entering its wait.", { cause: exit })
				}),
			]),
			"entering the engine wait",
		)
	return {
		start: async () => {
			let before = counts()
			let fiber: Fiber.Fiber<PiTurnOutcome | null> = Effect.runFork(
				runPiDurableTurn(backend, request),
			)
			let atWait: ReturnType<typeof counts>
			try {
				atWait = await waitEntered(fiber)
				if (path === "recovery") {
					await waitForPauseProbe(
						Effect.runPromise(Fiber.interrupt(fiber)),
						"stopping the initial waiter",
					)
					entered = Promise.withResolvers<ReturnType<typeof counts>>()
					before = counts()
					fiber = Effect.runFork(recoverPiDurableTurn(backend, request.operationId))
					atWait = await waitEntered(fiber)
				}
			} catch (error) {
				await waitForPauseProbe(
					Effect.runPromise(Fiber.interrupt(fiber)),
					"stopping the failed waiter",
				)
				throw error
			}
			return {
				atWait: {
					waitCalls: atWait.waitCalls - before.waitCalls,
					submissionReads: atWait.submissionReads - before.submissionReads,
				},
				counts: () => {
					const observed = counts()
					return {
						waitCalls: observed.waitCalls - before.waitCalls,
						submissionReads: observed.submissionReads - atWait.submissionReads,
						inspections: observed.inspections - atWait.inspections,
						taskScans: observed.taskScans - atWait.taskScans,
						waitAborts: observed.waitAborts - atWait.waitAborts,
						turnAborts: observed.turnAborts - atWait.turnAborts,
					}
				},
				result: () =>
					waitForPauseProbe(Effect.runPromise(Fiber.join(fiber)), "reading the turn outcome"),
				stop: () =>
					waitForPauseProbe(Effect.runPromise(Fiber.interrupt(fiber)), "stopping the waiter"),
				abort: () =>
					waitForPauseProbe(
						Effect.runPromise(backend.abort(request.operationId)),
						"aborting the turn",
					),
			}
		},
		restore: () => {
			taskScan.mockRestore()
			inspection.mockRestore()
			submission.mockRestore()
		},
	}
}
