import * as Effect from "effect/Effect"
import { expect, it } from "vitest"
import type { Sandbox } from "../src/Sandbox/Sandboxes.ts"
import { withCallSignal } from "../src/Workspace/CallSignal.ts"
import { makeSandboxMount } from "../src/Workspace/SandboxMount.ts"

const file = () => new Blob(["contents"]).stream()

const fakeSandbox = (
	write?: (path: string) => Promise<void>,
	run?: (command: ReadonlyArray<string>) => Promise<void>,
) => {
	const calls: Array<ReadonlyArray<string>> = []
	const sandbox: Sandbox = {
		incarnation: "fixture",
		readFile: () => Effect.succeed(new Uint8Array()),
		readTextFile: () => Effect.succeed(""),
		exec: (args) =>
			Effect.promise(async () => {
				const command = typeof args === "string" ? [args] : args
				calls.push(command)
				await run?.(command)
				return {
					exitCode: 0,
					stdout: command[2]?.includes("mktemp") === true ? "/workspace/.checkfu-fixture\n" : "",
					stderr: "",
				}
			}),
		writeFile: (path) =>
			Effect.promise(async () => {
				calls.push(["write", path])
				await write?.(path)
			}),
	}
	const admissionSignals: Array<AbortSignal | undefined> = []
	const mount = makeSandboxMount("/workspace", (dispatch, signal, access) => {
		admissionSignals.push(signal)
		return Effect.runPromise(
			dispatch(sandbox),
			signal === undefined || access?.retainOutcome === true ? {} : { signal },
		)
	})
	return { mount, calls, admissionSignals }
}

it("cancels a paused body promptly without dispatching a write or cancelling a sibling", async () => {
	const { mount, calls } = fakeSandbox()
	const abort = new AbortController()
	const pulled = Promise.withResolvers<void>()
	const blocked = Promise.withResolvers<void>()
	const cancellation = Promise.withResolvers<unknown>()
	const body = new ReadableStream<Uint8Array>(
		{
			pull: () => {
				pulled.resolve()
				return blocked.promise
			},
			cancel: (reason: unknown) => {
				cancellation.resolve(reason)
				return blocked.promise
			},
		},
		{ highWaterMark: 0 },
	)
	const pending = withCallSignal(abort.signal, () =>
		mount.writeFile!("cancelled", body, { exclusive: true }),
	)
	const reason = new Error("Stopped")
	const result = expect(pending).rejects.toBe(reason)
	await pulled.promise
	abort.abort(reason)
	await result
	expect(await cancellation.promise).toBe(reason)
	expect(body.locked).toBe(false)
	await withCallSignal(new AbortController().signal, () => mount.writeFile!("sibling", file(), {}))
	expect(calls).toEqual([["write", "/workspace/sibling"]])
	blocked.resolve()
})

it("refuses mount operations before dispatch when the option signal is aborted", async () => {
	const { mount, calls } = fakeSandbox()
	const reason = new Error("Stopped")
	const signal = AbortSignal.abort(reason)
	await expect(mount.writeFile!("write", file(), { signal })).rejects.toBe(reason)
	await expect(mount.stat("", { signal })).rejects.toBe(reason)
	await expect(mount.readdir("", { signal })).rejects.toBe(reason)
	await expect(mount.readFile("read", { signal })).rejects.toBe(reason)
	await expect(mount.mkdir!("mkdir", { signal })).rejects.toBe(reason)
	await expect(mount.rm!("rm", { signal })).rejects.toBe(reason)
	await expect(mount.rename!("before", "after", { signal })).rejects.toBe(reason)
	await expect(mount.chmod!("chmod", 0o600, { signal })).rejects.toBe(reason)
	expect(calls).toEqual([])
})

it("only cleans its reservation after cancellation during staging", async () => {
	const writing = Promise.withResolvers<void>()
	const finish = Promise.withResolvers<void>()
	const { mount, calls } = fakeSandbox(() => {
		writing.resolve()
		return finish.promise
	})
	const option = new AbortController()
	const reason = new Error("Stopped")
	const pending = withCallSignal(new AbortController().signal, () =>
		mount.writeFile!("target", file(), { signal: option.signal, exclusive: true, mode: 0o640 }),
	)
	const rejection = expect(pending).rejects.toBe(reason)
	await writing.promise
	option.abort(reason)
	finish.resolve()
	await rejection
	expect(calls).toEqual([
		["sh", "-c", expect.stringContaining("mktemp"), "sh", "/workspace", "/workspace/target"],
		["write", "/workspace/.checkfu-fixture/file"],
		[
			"sh",
			"-c",
			expect.stringContaining("rmdir"),
			"sh",
			"/workspace/.checkfu-fixture/file",
			"/workspace/.checkfu-fixture",
		],
	])
})

it("waits for an already-dispatched placement before deleting its staging file", async () => {
	const placing = Promise.withResolvers<void>()
	const finish = Promise.withResolvers<void>()
	const { mount, calls, admissionSignals } = fakeSandbox(undefined, (args) => {
		if (args[2]?.includes("linkSync") === true) {
			placing.resolve()
			return finish.promise
		}
		return Promise.resolve()
	})
	const controller = new AbortController()
	const pending = mount.writeFile!("target", file(), { signal: controller.signal, exclusive: true })
	await placing.promise
	expect(admissionSignals).toEqual([controller.signal, controller.signal, controller.signal])
	controller.abort()
	await new Promise<void>((resolve) => {
		setTimeout(resolve, 0)
	})
	expect(calls.some((args) => args[2]?.startsWith("rm -f --") === true)).toBe(false)
	finish.resolve()
	await pending
	expect(calls.at(-1)).toEqual([
		"sh",
		"-c",
		expect.stringContaining("rmdir"),
		"sh",
		"/workspace/.checkfu-fixture/file",
		"/workspace/.checkfu-fixture",
	])
})
