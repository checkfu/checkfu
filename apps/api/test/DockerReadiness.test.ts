import { expect, it, vi } from "vitest"
import { dockerServerVersion, waitForDocker } from "./workerd/WorkerdStack.ts"

const unavailable = Object.assign(new Error("Docker is starting."), {
	stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock.",
})

it("checks the daemon immediately and retries startup failures and empty versions", async () => {
	const probe = vi
		.fn<() => string>()
		.mockImplementationOnce(() => {
			throw unavailable
		})
		.mockReturnValueOnce("")
		.mockReturnValue("29.7.2")
	await expect(waitForDocker(probe)).resolves.toBe("29.7.2")
	expect(probe).toHaveBeenCalledTimes(3)
	expect(probe).toHaveBeenNthCalledWith(1, 2000)
})

it("fails immediately for a missing CLI or a daemon permission error", async () => {
	for (const cause of [
		Object.assign(new Error("spawnSync docker ENOENT"), { code: "ENOENT" }),
		Object.assign(new Error("Docker could not connect"), {
			stderr: "permission denied while trying to connect to the Docker daemon",
		}),
	]) {
		const probe = vi.fn(() => {
			throw cause
		})
		await expect(waitForDocker(probe)).rejects.toMatchObject({ cause })
		expect(probe).toHaveBeenCalledTimes(1)
	}
})

it("caps an unresponsive daemon probe at the remaining startup budget", async () => {
	vi.useFakeTimers({ toFake: ["performance", "setTimeout"] })
	try {
		const cause = Object.assign(new Error("The daemon did not answer"), { code: "ETIMEDOUT" })
		const probe = vi.fn(() => {
			throw cause
		})
		const result = expect(waitForDocker(probe, 600)).rejects.toMatchObject({ cause })
		await vi.advanceTimersByTimeAsync(600)
		await result
		expect(probe.mock.calls).toEqual([[600], [350], [100]])
	} finally {
		vi.useRealTimers()
	}
})

it("forcibly stops a version query that ignores termination", async () => {
	const start = performance.now()
	await expect(
		waitForDocker(
			(timeout) =>
				dockerServerVersion(timeout, process.execPath, [
					"-e",
					'process.on("SIGTERM", () => {}); setTimeout(() => {}, 3000)',
				]),
			400,
		),
	).rejects.toMatchObject({ cause: { code: "ETIMEDOUT", signal: "SIGKILL" } })
	expect(performance.now() - start).toBeLessThan(2000)
})
