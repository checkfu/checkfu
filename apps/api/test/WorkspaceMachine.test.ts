import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import type { ExecResult, Sandbox } from "../src/Sandbox/Sandboxes.ts"
import type { Archive, SavedDisk } from "../src/Workspace/SavedDisk.ts"
import { makeWorkspaceMachine } from "../src/Workspace/WorkspaceMachine.ts"
import type { StoredFiles } from "../src/Workspace/WorkspaceMachine.ts"

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)
const bytesOf = (value: string | Uint8Array): Uint8Array =>
	typeof value === "string" ? new TextEncoder().encode(value) : value
const joined = (parts: ReadonlyArray<Uint8Array>): string => parts.map(text).join("")

const SEEDED = "as stored before the first command"

interface Disk {
	readonly incarnation: string
	content: string
	readonly added: Array<string>
	readonly staged: Map<string, Uint8Array>
}

const makePlatform = () => {
	const state = {
		disk: undefined as Disk | undefined,
		opened: [] as Array<string>,
		removed: 0,
		commands: [] as Array<ReadonlyArray<string>>,
		stopped: [] as Array<string>,
		answer: (): Promise<ExecResult> => Promise.resolve({ exitCode: 0, stdout: "", stderr: "0" }),
		failOpen: false,
	}
	const done = (stdout = "", exitCode = 0): ExecResult => ({ exitCode, stdout, stderr: "" })
	const stagedUnder = (disk: Disk, directory: string): ReadonlyArray<Uint8Array> =>
		[...disk.staged.entries()]
			.filter(([path]) => path.startsWith(`${directory}/`))
			.toSorted(([a], [b]) => a.localeCompare(b))
			.map(([, bytes]) => bytes)
	const sandboxOn = (disk: Disk): Sandbox => {
		const alive = <A>(work: () => A | Promise<A>): Effect.Effect<A> =>
			Effect.suspend(() =>
				state.disk === disk
					? Effect.promise(async () => work())
					: Effect.die(new Error("The machine is not running.")),
			)
		return {
			incarnation: disk.incarnation,
			exec: (command) =>
				alive(() => {
					if (typeof command === "string") {
						return done()
					}
					if (command[0] === "rm") {
						for (const path of disk.staged.keys()) {
							if (path.startsWith(`${command.at(-1)}/`)) {
								disk.staged.delete(path)
							}
						}
						return done()
					}
					const [, , script = "", , ...args] = command
					if (script.includes("tar -x")) {
						const [staging = "", , format] = args
						const unpacked = joined(stagedUnder(disk, staging))
						if (format === "zstd") {
							disk.content = unpacked
							disk.added.length = 0
						} else if (unpacked.includes("seed.txt")) {
							disk.content = SEEDED
						} else {
							disk.added.push(unpacked.includes("api/") ? "api" : "docs")
						}
						return done()
					}
					if (script.includes("tar -c")) {
						disk.staged.set(`${args[1]}/000000`, bytesOf(disk.content))
						return done("1\n")
					}
					if (script.includes("kill -TERM")) {
						state.stopped.push(args[0] ?? "")
						return done()
					}
					state.commands.push(command)
					return state.answer()
				}),
			readFile: (path) => alive(() => disk.staged.get(path) ?? new Uint8Array()),
			readTextFile: (path) => alive(() => text(disk.staged.get(path) ?? new Uint8Array())),
			writeFile: (path, content) =>
				alive(() => {
					disk.staged.set(path, bytesOf(content))
				}),
		}
	}
	return {
		state,
		kill: () => {
			state.disk = undefined
		},
		sandboxes: {
			open: (key: string) =>
				Effect.suspend(() => {
					if (state.failOpen) {
						return Effect.die(new Error("no machine to be had"))
					}
					if (state.disk === undefined) {
						state.opened.push(key)
						state.disk = {
							incarnation: String(state.opened.length),
							content: "",
							added: [],
							staged: new Map(),
						}
					}
					return Effect.succeed(sandboxOn(state.disk))
				}),
			remove: () =>
				Effect.sync(() => {
					state.removed += 1
					state.disk = undefined
				}),
		},
	}
}

const makeStored = () => {
	const tree = new Map<string, ReadonlyArray<string>>([
		["/workspace", ["seed.txt", "api", "docs"]],
		["/workspace/api", ["README.md"]],
		["/workspace/docs", ["README.md"]],
	])
	const stored: StoredFiles = {
		readdir: (path) => {
			const names = tree.get(path)
			return names === undefined
				? Promise.reject(new Error(`no such path: ${path}`))
				: Promise.resolve(
						names.map((name) => ({
							name,
							isDirectory: tree.has(`${path}/${name}`),
							isSymbolicLink: false,
						})),
					)
		},
		lstat: () => Promise.resolve({ mode: 0o755, size: 0, mtime: 0 }),
		readlink: () => Promise.resolve(""),
		readFile: () =>
			Promise.resolve(
				new ReadableStream({
					start: (controller) => {
						controller.close()
					},
				}),
			),
	}
	return { tree, stored }
}

const pause = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, ms)
	})

const deferred = () => {
	let release: () => void = () => undefined
	const held = new Promise<void>((resolve) => {
		release = resolve
	})
	return { held, release }
}

const makeMachine = () => {
	const platform = makePlatform()
	const kept = new Map<string, unknown>()
	const { tree, stored } = makeStored()
	interface Kept {
		readonly bytes: ReadonlyArray<Uint8Array>
		readonly compressed: boolean
	}
	const saved = {
		archives: undefined as ReadonlyArray<Kept> | undefined,
		fail: false,
		hold: Promise.resolve(),
		started: 0,
	}
	const collect = async (archive: Archive): Promise<Kept> => {
		const bytes: Array<Uint8Array> = []
		for await (const chunk of archive.chunks) {
			bytes.push(chunk)
		}
		return { bytes, compressed: archive.compressed }
	}
	const disk: SavedDisk = {
		read: () =>
			saved.archives?.map(({ bytes, compressed }) => ({
				chunks: (async function* () {
					yield* bytes
				})(),
				compressed,
			})),
		replace: async (archive) => {
			saved.started += 1
			const next = await collect(archive)
			await saved.hold
			if (saved.fail) {
				throw new Error("no room to save")
			}
			saved.archives = [next]
		},
		append: async (archive) => {
			saved.archives = [...(saved.archives ?? []), await collect(archive)]
		},
	}
	let settled = 0
	const options = {
		sandboxes: platform.sandboxes,
		key: "sess_1",
		store: {
			get: <A>(key: string) => kept.get(key) as A | undefined,
			put: (key: string, value: unknown) => {
				kept.set(key, value)
			},
			delete: (key: string) => {
				kept.delete(key)
			},
		},
		disk,
		directory: "/workspace",
		stored,
		settled: () => {
			settled += 1
			return Promise.resolve()
		},
	}
	const content = (machine: ReturnType<typeof makeWorkspaceMachine>) =>
		machine.inMachine((sandbox) =>
			Effect.map(sandbox.readFile("/probe"), () => platform.state.disk?.content),
		)
	return {
		...platform,
		tree,
		saved,
		settled: () => settled,
		content,
		savedContent: () => saved.archives?.[0]?.bytes.map(text).join(""),
		machine: makeWorkspaceMachine(options),
		again: () => makeWorkspaceMachine(options),
	}
}

describe("workspace machine", () => {
	it("starts one machine at the first call and fills it from what the session stored", async () => {
		const { machine, state, content, settled } = makeMachine()
		expect(machine.engaged()).toBe(false)
		expect(await Promise.all([content(machine), content(machine)])).toEqual([SEEDED, SEEDED])
		await content(machine)
		expect([state.opened.length, settled(), machine.engaged()]).toEqual([1, 1, true])
	})

	it("goes on without a machine when the first one cannot be had or filled", async () => {
		const { machine, state, content, tree } = makeMachine()
		state.failOpen = true
		await expect(content(machine)).rejects.toThrow("no machine to be had")
		expect(machine.engaged()).toBe(false)
		state.failOpen = false
		const working = tree.get("/workspace") ?? []
		tree.delete("/workspace")
		await expect(content(machine)).rejects.toThrow("no such path: /workspace")
		expect([machine.engaged(), state.disk, state.removed]).toEqual([false, undefined, 2])
		tree.set("/workspace", working)
		expect(await content(machine)).toBe(SEEDED)
		expect(machine.engaged()).toBe(true)
	})

	it("saves the working directory when it sleeps, and wakes a new machine with it", async () => {
		const { machine, state, content, savedContent, again } = makeMachine()
		await content(machine)
		state.disk!.content = "after an afternoon of work"
		expect(await machine.sleep()).toBe(true)
		expect([state.disk, state.removed, savedContent()]).toEqual([
			undefined,
			1,
			"after an afternoon of work",
		])
		expect(await machine.sleep()).toBe(false)
		expect(await content(again())).toBe("after an afternoon of work")
		expect(state.opened.length).toBe(2)
		expect([...state.disk!.staged.keys()]).toEqual([])
	})

	it("lets no call near the machine while it is saved, and waits for the ones under way", async () => {
		const { machine, state, content, saved } = makeMachine()
		await content(machine)
		state.disk!.content = "before the save"
		const call = deferred()
		const under = machine.inMachine(() => Effect.promise(() => call.held))
		const save = deferred()
		saved.hold = save.held
		const sleeping = machine.sleep()
		await Promise.resolve()
		expect(saved.started).toBe(0)
		call.release()
		await under
		const first = state.disk
		const late = content(machine).then((value) => [value, state.disk === first])
		await pause(20)
		expect(saved.started).toBe(1)
		save.release()
		await sleeping
		expect(await late).toEqual(["before the save", false])
		expect(state.opened.length).toBe(2)
	})

	it("keeps the last save and the machine when a save fails", async () => {
		const { machine, state, content, saved, savedContent } = makeMachine()
		await content(machine)
		state.disk!.content = "first"
		await machine.sleep()
		await content(machine)
		state.disk!.content = "second"
		saved.fail = true
		await expect(machine.sleep()).rejects.toThrow("no room to save")
		expect([savedContent(), state.removed]).toEqual(["first", 1])
		expect(await content(machine)).toBe("second")
		expect([...state.disk!.staged.keys()]).toEqual([])
	})

	it("knows a machine still running after its object was evicted, whatever a command removed in it", async () => {
		const { machine, state, content, again } = makeMachine()
		await content(machine)
		state.disk!.content = ""
		expect(await content(again())).toBe("")
		expect(state.opened.length).toBe(1)
		await again().sleep()
		expect(await content(again())).toBe("")
	})

	it("tells the call that finds its machine replaced, once, and fills the new one from the last save", async () => {
		const { machine, state, content, kill } = makeMachine()
		await content(machine)
		state.disk!.content = "saved"
		await machine.sleep()
		await content(machine)
		state.disk!.content = "not saved"
		kill()
		await expect(content(machine)).rejects.toThrow("a new one took its place")
		expect(await content(machine)).toBe("saved")
		expect(state.opened.length).toBe(3)
	})

	it("fills a machine replaced before any save from what the session stored, and says so", async () => {
		const { state, content, kill, again } = makeMachine()
		await content(again())
		state.disk!.content = "never saved"
		kill()
		const evicted = again()
		await expect(content(evicted)).rejects.toThrow("before the first command")
		expect(await content(evicted)).toBe(SEEDED)
	})

	it("passes on a failure that was not the machine's, with the machine as it was", async () => {
		const { machine, state } = makeMachine()
		await machine.inMachine(() => Effect.void)
		await expect(machine.inMachine(() => Effect.die(new Error("disk full")))).rejects.toThrow(
			"disk full",
		)
		expect(state.opened.length).toBe(1)
	})

	it("keeps the notice for the next call when a replaced machine is found while going to sleep", async () => {
		const { machine, state, content, kill, savedContent } = makeMachine()
		await content(machine)
		state.disk!.content = "saved"
		await machine.sleep()
		await content(machine)
		kill()
		await machine.sleep()
		expect([savedContent(), state.disk]).toEqual(["saved", undefined])
		await expect(content(machine)).rejects.toThrow("a new one took its place")
		expect(await content(machine)).toBe("saved")
	})

	it("gives a repository added later to the machine that is awake and to every machine after it", async () => {
		const { machine, state, content, kill } = makeMachine()
		await content(machine)
		await machine.add("/workspace/api")
		expect(state.disk?.added).toEqual(["api"])
		await machine.sleep()
		await machine.add("/workspace/docs")
		expect(state.disk).toBeUndefined()
		await content(machine)
		expect(state.disk?.added).toEqual(["docs"])
		await machine.add("/workspace/api")
		expect(state.disk?.added).toEqual(["docs", "api"])
		kill()
		await expect(content(machine)).rejects.toThrow("a new one took its place")
		expect(state.disk?.added).toEqual(["docs", "api"])
	})

	it("leaves a repository the agent removed out of every machine after the next save", async () => {
		const { machine, state, content } = makeMachine()
		await content(machine)
		await machine.sleep()
		await machine.add("/workspace/api")
		await content(machine)
		expect(state.disk?.added).toEqual(["api"])
		state.disk!.content = "without the repository"
		state.disk!.added.length = 0
		await machine.sleep()
		expect(await content(machine)).toBe("without the repository")
		expect(state.disk?.added).toEqual([])
	})

	it("removes only a machine the session asked for", async () => {
		const { machine, state, content } = makeMachine()
		expect([await machine.sleep(), await machine.remove()]).toEqual([false, false])
		await content(machine)
		expect(await machine.remove()).toBe(true)
		expect(state.removed).toBe(1)
	})

	it("answers a command with the end of its output, what was cut, and how it ended", async () => {
		const { machine, state } = makeMachine()
		const run = (answer: ExecResult) => {
			state.answer = () => Promise.resolve(answer)
			return machine.command(["bash", "-c", "make"], { cwd: "/workspace", seconds: 5 }, undefined)
		}
		expect(await run({ exitCode: 0, stdout: "built\n", stderr: "6" })).toEqual({
			content: [{ type: "text", text: "built" }],
			isError: false,
		})
		expect(await run({ exitCode: 0, stdout: "", stderr: "0" })).toEqual({
			content: [{ type: "text", text: "(no output)" }],
			isError: false,
		})
		expect(await run({ exitCode: 2, stdout: "tail\n", stderr: "1005" })).toEqual({
			content: [
				{
					type: "text",
					text: "[The first 1000 bytes of the output are not shown.]\ntail\n[Exit code 2.]",
				},
			],
			isError: true,
		})
		expect(await run({ exitCode: 124, stdout: "", stderr: "Timed out after 35000 ms." })).toEqual({
			content: [{ type: "text", text: "[Stopped after 5 seconds.]" }],
			isError: true,
		})
		expect(state.commands.at(-1)?.slice(4, 6)).toEqual(["/workspace", "5"])
		expect(state.commands.at(-1)?.slice(-3)).toEqual(["bash", "-c", "make"])
	})

	it("stops a command whose call is stopped, and does not start one already stopped", async () => {
		const { machine, state } = makeMachine()
		const stopping = new AbortController()
		const running = deferred()
		state.answer = async () => {
			await running.held
			return { exitCode: 143, stdout: "half\n", stderr: "5" }
		}
		const call = machine.command(
			["sleep", "600"],
			{ cwd: "/workspace", seconds: 600 },
			stopping.signal,
		)
		await pause(10)
		expect(state.stopped).toEqual([])
		stopping.abort()
		await pause(10)
		expect(state.stopped).toEqual([state.commands.at(-1)?.[8]])
		running.release()
		expect(await call).toEqual({
			content: [{ type: "text", text: "half\n[Stopped: the turn was interrupted.]" }],
			isError: true,
		})
		const before = state.commands.length
		expect(
			await machine.command(["make"], { cwd: "/workspace", seconds: 5 }, stopping.signal),
		).toEqual({
			content: [{ type: "text", text: "[Stopped: the turn was interrupted.]" }],
			isError: true,
		})
		expect(state.commands.length).toBe(before)
	})
})
