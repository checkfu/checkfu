import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { resolve } from "node:path"
import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { SandboxError } from "../../src/Sandbox/Sandboxes.ts"
import type { Sandbox } from "../../src/Sandbox/Sandboxes.ts"
import { cloneCommand } from "../../src/Workspace/Repositories.ts"
import type { RepositoryMount } from "../../src/Workspace/WorkspaceShapes.ts"
import { WRITE_FILE } from "../../src/Sandbox/WriteFile.ts"
import { makeSandboxMount } from "../../src/Workspace/SandboxMount.ts"
import type { InSandbox } from "../../src/Workspace/SandboxMount.ts"
import {
	archiveOf,
	makeWorkspaceMachine,
	packDirectory,
	unpackInto,
} from "../../src/Workspace/WorkspaceMachine.ts"
import type { StoredFiles } from "../../src/Workspace/WorkspaceMachine.ts"
import type { Archive } from "../../src/Workspace/SavedDisk.ts"

const IMAGE = resolve(import.meta.dirname, "../../src/Sandbox/image")

interface Ran {
	readonly exitCode: number
	readonly stdout: Buffer
	readonly stderr: Buffer
}

const docker = (args: ReadonlyArray<string>, stdin?: Uint8Array): Promise<Ran> =>
	new Promise((done, failed) => {
		const child = spawn("docker", [...args], { stdio: ["pipe", "pipe", "pipe"] })
		const stdout: Array<Buffer> = []
		const stderr: Array<Buffer> = []
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
		child.on("error", failed)
		child.on("close", (code) => {
			done({ exitCode: code ?? 1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) })
		})
		child.stdin.end(stdin)
	})

const containerSandbox = (container: string): Sandbox => {
	const read = (path: string) =>
		Effect.promise(
			async () => new Uint8Array((await docker(["exec", container, "cat", "--", path])).stdout),
		)
	return {
		incarnation: container,
		exec: (command, options = {}) =>
			Effect.promise(async () => {
				const ran = await docker([
					"exec",
					...(options.cwd === undefined ? [] : ["--workdir", options.cwd]),
					...Object.entries(options.env ?? {}).flatMap(([name, value]) => [
						"--env",
						`${name}=${value}`,
					]),
					container,
					...(typeof command === "string" ? ["sh", "-c", command] : command),
				])
				return {
					exitCode: ran.exitCode,
					stdout: ran.stdout.toString("utf8"),
					stderr: ran.stderr.toString("utf8"),
				}
			}),
		readFile: read,
		readTextFile: (path) => Effect.map(read(path), (bytes) => new TextDecoder().decode(bytes)),
		writeFile: (path, content) =>
			Effect.flatMap(
				Effect.promise(() =>
					docker(
						["exec", "--interactive", container, "sh", "-c", WRITE_FILE, "sh", path],
						typeof content === "string" ? new TextEncoder().encode(content) : content,
					),
				),
				(written) =>
					written.exitCode === 0
						? Effect.void
						: Effect.fail(new SandboxError({ message: written.stderr.toString("utf8").trim() })),
			),
	}
}

const body = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
	new ReadableStream({
		start: (controller) => {
			if (bytes.byteLength > 0) {
				controller.enqueue(bytes)
			}
			controller.close()
		},
	})

type Stored =
	| { readonly kind: "file"; readonly mode: number; readonly content: Uint8Array }
	| { readonly kind: "dir"; readonly mode: number }
	| { readonly kind: "link"; readonly target: string }

const storedFiles = (tree: ReadonlyMap<string, Stored>): StoredFiles => {
	const at = (path: string): Stored => {
		const entry = tree.get(path)
		if (entry === undefined) {
			throw Object.assign(new Error(`Nothing stored at ${path}`), { code: "ENOENT" })
		}
		return entry
	}
	return {
		readdir: (path) =>
			Promise.resolve(
				[...tree.entries()].flatMap(([name, entry]) => {
					const below = name.startsWith(`${path}/`) ? name.slice(path.length + 1) : "/"
					return below.includes("/")
						? []
						: [
								{
									name: below,
									isDirectory: entry.kind === "dir",
									isSymbolicLink: entry.kind === "link",
								},
							]
				}),
			),
		lstat: (path) => {
			const entry = at(path)
			return Promise.resolve({
				mode: entry.kind === "link" ? 0o777 : entry.mode,
				size: entry.kind === "file" ? entry.content.byteLength : 0,
				mtime: Date.UTC(2026, 0, 2),
				isDirectory: entry.kind === "dir",
				isSymbolicLink: entry.kind === "link",
			})
		},
		readlink: (path) => {
			const entry = at(path)
			return Promise.resolve(entry.kind === "link" ? entry.target : "")
		},
		readFile: (path) => {
			const entry = at(path)
			return Promise.resolve(body(entry.kind === "file" ? entry.content : new Uint8Array()))
		},
	}
}

const text = (value: string): Uint8Array => new TextEncoder().encode(value)
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")
const patterned = (length: number): Uint8Array =>
	Uint8Array.from({ length }, (_, index) => (index * 31 + (index >> 8) * 7) % 256)
const collect = async (body: ReadableStream<Uint8Array>): Promise<Uint8Array> =>
	new Uint8Array(await new Response(body).arrayBuffer())
const codeOf = (work: Promise<unknown>): Promise<string> =>
	work.then(
		() => "no error",
		(error: unknown) => String(Predicate.hasProperty(error, "code") ? error.code : error),
	)

const names = (entries: ReadonlyArray<{ readonly name: string; readonly type: string }> | null) =>
	entries?.map(({ name, type }) => `${type} ${name}`).sort()

const pause = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, ms)
	})

describe("a session's machine, in a container of its image", () => {
	let container = ""
	let sandbox: Sandbox
	const sent: Array<ReadonlyArray<string>> = []
	const inContainer: InSandbox = (call) =>
		Effect.runPromise(
			call({
				...sandbox,
				exec: (command, options) => {
					sent.push(typeof command === "string" ? [command] : command)
					return sandbox.exec(command, options)
				},
			}),
		)
	const clone = (repository: RepositoryMount) =>
		Effect.runPromise(sandbox.exec(cloneCommand(repository), { cwd: "/" }))
	const sh = async (script: string): Promise<string> => {
		const ran = await Effect.runPromise(sandbox.exec(["bash", "-c", script]))
		return ran.stdout
	}

	beforeAll(async () => {
		const built = spawnSync("docker", ["build", "--quiet", IMAGE], { encoding: "utf8" })
		if (built.status !== 0) {
			throw new Error(`The machine's image did not build: ${built.stderr}`)
		}
		const started = await docker([
			"run",
			"--detach",
			"--rm",
			built.stdout.trim(),
			"sleep",
			"infinity",
		])
		container = started.stdout.toString("utf8").trim()
		sandbox = containerSandbox(container)
	}, 300_000)

	afterAll(async () => {
		if (container !== "") {
			await docker(["rm", "--force", container])
		}
	}, 60_000)

	it("copies a stored directory in whole: nested, empty, executable, linked, and larger than one part", async () => {
		const large = patterned(9 * 1024 * 1024 + 5)
		const tree = new Map<string, Stored>([
			["/workspace/repo", { kind: "dir", mode: 0o755 }],
			["/workspace/repo/README.md", { kind: "file", mode: 0o644, content: text("# Repo\n") }],
			["/workspace/repo/bin", { kind: "dir", mode: 0o755 }],
			[
				"/workspace/repo/bin/run.sh",
				{ kind: "file", mode: 0o755, content: text("#!/bin/sh\necho ran\n") },
			],
			["/workspace/repo/empty", { kind: "dir", mode: 0o700 }],
			["/workspace/repo/latest", { kind: "link", target: "bin/run.sh" }],
			[
				'/workspace/repo/it\'s a "name" – ü.txt',
				{ kind: "file", mode: 0o600, content: text("odd\n") },
			],
			["/workspace/large.bin", { kind: "file", mode: 0o644, content: large }],
			["/workspace/nothing", { kind: "file", mode: 0o644, content: new Uint8Array() }],
		])
		await unpackInto(sandbox, "/workspace", {
			chunks: packDirectory(storedFiles(tree), "/workspace", "/workspace"),
			compressed: false,
		})
		await sh("rm -rf /workspace/repo/bin")
		await unpackInto(sandbox, "/workspace", {
			chunks: packDirectory(storedFiles(tree), "/workspace/repo/bin", "/workspace"),
			compressed: false,
		})
		expect(await sh("cd /workspace && find . -mindepth 1 | sort")).toBe(
			[
				"./large.bin",
				"./nothing",
				"./repo",
				"./repo/README.md",
				"./repo/bin",
				"./repo/bin/run.sh",
				"./repo/empty",
				'./repo/it\'s a "name" – ü.txt',
				"./repo/latest",
				"",
			].join("\n"),
		)
		expect(await sh("cd /workspace/repo && stat -c '%a %F' bin/run.sh empty README.md")).toBe(
			"755 regular file\n700 directory\n644 regular file\n",
		)
		expect(await sh("cd /workspace/repo && readlink latest && ./latest")).toBe("bin/run.sh\nran\n")
		expect(await sh("sha256sum < /workspace/large.bin | cut -d' ' -f1")).toBe(`${sha256(large)}\n`)
		expect(await sh("ls /tmp | grep -c checkfu- || true")).toBe("0\n")
	}, 120_000)

	it("saves a directory of the machine and unpacks it as it was, in a machine that has nothing", async () => {
		await sh(
			String.raw`mkdir -p /workspace/save/repo/bin /workspace/save/empty && cd /workspace/save && printf '#!/bin/sh\necho ran\n' > repo/bin/run.sh && chmod 755 repo/bin/run.sh && ln -s bin/run.sh repo/latest && printf 'odd\n' > "repo/it's a \"name\".txt" && chmod 600 repo/it* && head -c 9000000 /dev/urandom > large.bin && : > nothing`,
		)
		const listing = String.raw`cd "$0" && find . -mindepth 1 -printf '%P %y %m %s %l\n' | sort && sha256sum large.bin`
		const before = await Effect.runPromise(sandbox.exec(["sh", "-c", listing, "/workspace/save"]))
		const chunks: Array<Uint8Array> = []
		for await (const chunk of archiveOf(sandbox, "/workspace/save")) {
			chunks.push(chunk)
		}
		expect(chunks.length).toBeGreaterThan(2)
		expect(chunks.every((chunk) => chunk.byteLength <= 4 * 1024 * 1024)).toBe(true)
		await unpackInto(sandbox, "/workspace/restored", {
			chunks: (async function* () {
				yield* chunks
			})(),
			compressed: true,
		})
		const after = await Effect.runPromise(
			sandbox.exec(["sh", "-c", listing, "/workspace/restored"]),
		)
		expect(after.stdout).toBe(before.stdout)
		const corrupt = chunks.map((chunk, index) =>
			index === chunks.length - 1
				? Uint8Array.from(chunk, (byte, at) => (at === chunk.byteLength - 1 ? byte ^ 0xff : byte))
				: chunk,
		)
		await expect(
			unpackInto(sandbox, "/workspace/corrupt", {
				chunks: (async function* () {
					yield* corrupt
				})(),
				compressed: true,
			}),
		).rejects.toThrow("Could not unpack")
		await sh("rm -rf /workspace/corrupt")
		expect(before.stdout).toContain("repo/latest l 777 10 bin/run.sh")
		expect(await sh("/workspace/restored/repo/latest")).toBe("ran\n")
		for await (const chunk of archiveOf(sandbox, "/workspace/save")) {
			expect(chunk.byteLength).toBeGreaterThan(0)
			break
		}
		expect(await sh("ls /tmp | grep checkfu- | grep -vc '^checkfu-calls$' || true")).toBe("0\n")
		await sh("rm -rf /workspace/save /workspace/restored")

		const gone: Array<Uint8Array> = []
		for await (const chunk of archiveOf(sandbox, "/workspace/gone")) {
			gone.push(chunk)
		}
		await unpackInto(sandbox, "/workspace/back", {
			chunks: (async function* () {
				yield* gone
			})(),
			compressed: true,
		})
		expect(await sh("ls -A /workspace/back | wc -l")).toBe("0\n")
		await sh("rm -rf /workspace/gone /workspace/back")
	}, 120_000)

	it("upgrades a legacy workspace snapshot and saves outputs with the workspace across sleep", async () => {
		const directory = "/workspace/output-upgrade"
		const outputs = "/mnt/session/outputs/upgrade"
		const kept = new Map<string, unknown>()
		let saved: { parts: ReadonlyArray<Uint8Array>; compressed: boolean; rooted?: true } | undefined
		const save = async (archive: Archive) => {
			const parts: Array<Uint8Array> = []
			for await (const part of archive.chunks) {
				parts.push(part)
			}
			saved = {
				parts,
				compressed: archive.compressed,
				...(archive.rooted ? { rooted: true as const } : {}),
			}
		}
		const tree = new Map<string, Stored>([
			[outputs, { kind: "dir", mode: 0o755 }],
			[`${outputs}/original.txt`, { kind: "file", mode: 0o644, content: text("STORED\n") }],
		])
		const make = () =>
			makeWorkspaceMachine({
				sandboxes: {
					open: () => Effect.succeed(sandbox),
					remove: () =>
						Effect.promise(async () => {
							await sh(`rm -rf -- ${directory} ${outputs}`)
						}),
				},
				key: "outputs-upgrade",
				store: {
					get: <A>(key: string) => kept.get(key) as A | undefined,
					put: (key, value) => {
						kept.set(key, value)
					},
					delete: (key) => {
						kept.delete(key)
					},
				},
				disk: {
					read: () => {
						const image = saved
						return image === undefined
							? undefined
							: {
									chunks: (async function* () {
										yield* image.parts
									})(),
									compressed: image.compressed,
									...(image.rooted ? { rooted: true as const } : {}),
								}
					},
					replace: save,
				},
				directory,
				extraDirectories: [outputs],
				stored: storedFiles(tree),
				settled: () => Promise.resolve(),
				touched: () => undefined,
			})
		const run = async (machine: ReturnType<typeof make>, command: string) => {
			const result = await machine.command(
				["bash", "-c", command],
				{ cwd: directory, seconds: 20 },
				undefined,
			)
			expect(result.isError).toBe(false)
			return result.content[0]?.type === "text" ? result.content[0].text : ""
		}
		try {
			await sh(`mkdir -p ${directory}; printf 'LEGACY\\n' > ${directory}/legacy.txt`)
			await save({ chunks: archiveOf(sandbox, directory), compressed: true })
			await sh(`rm -rf -- ${directory} ${outputs}`)
			const first = make()
			expect(await run(first, `cat legacy.txt ${outputs}/original.txt`)).toBe("LEGACY\nSTORED")
			await run(
				first,
				`printf 'AFTER\\n' > new.txt; printf 'NEW\\n' > ${outputs}/current.txt; rm ${outputs}/original.txt`,
			)
			await first.sleep()
			expect(saved?.rooted).toBe(true)
			expect(await sh(`[ -e ${directory} ] || [ -e ${outputs} ]; echo $?`)).toBe("1\n")
			const again = make()
			expect(
				await run(
					again,
					`cat legacy.txt new.txt ${outputs}/current.txt; test ! -e ${outputs}/original.txt`,
				),
			).toBe("LEGACY\nAFTER\nNEW")
		} finally {
			await sh(`rm -rf -- ${directory} ${outputs}`)
		}
	}, 120_000)

	it("imports stored outputs into an already running machine without overwriting its files or reviving later deletions", async () => {
		const directory = "/workspace/warm-output-upgrade"
		const outputs = "/mnt/session/outputs/warm-upgrade"
		const kept = new Map<string, unknown>([["machine", { incarnation: sandbox.incarnation }]])
		const tree = new Map<string, Stored>([
			[outputs, { kind: "dir", mode: 0o755 }],
			[`${outputs}/conflict.txt`, { kind: "file", mode: 0o644, content: text("STORED_OLD\n") }],
			[`${outputs}/imported.txt`, { kind: "file", mode: 0o644, content: text("IMPORTED\n") }],
		])
		const make = () =>
			makeWorkspaceMachine({
				sandboxes: { open: () => Effect.succeed(sandbox), remove: () => Effect.void },
				key: "warm-output-upgrade",
				store: {
					get: <A>(key: string) => kept.get(key) as A | undefined,
					put: (key, value) => {
						kept.set(key, value)
					},
					delete: (key) => {
						kept.delete(key)
					},
				},
				disk: { read: () => undefined, replace: async () => undefined },
				directory,
				extraDirectories: [outputs],
				stored: storedFiles(tree),
				settled: () => Promise.resolve(),
				touched: () => undefined,
			})
		try {
			await sh(
				`mkdir -p ${directory} ${outputs}; printf 'MACHINE_NEW\\n' > ${outputs}/conflict.txt`,
			)
			const first = make()
			const seen = await first.command(
				["cat", `${outputs}/conflict.txt`, `${outputs}/imported.txt`],
				{ cwd: directory, seconds: 20 },
				undefined,
			)
			expect(seen.isError).toBe(false)
			expect(seen.content).toEqual([{ type: "text", text: "MACHINE_NEW\nIMPORTED" }])
			await first.command(
				["rm", `${outputs}/imported.txt`],
				{ cwd: directory, seconds: 20 },
				undefined,
			)
			const again = make()
			const absent = await again.command(
				["test", "!", "-e", `${outputs}/imported.txt`],
				{ cwd: directory, seconds: 20 },
				undefined,
			)
			expect(absent.isError).toBe(false)
		} finally {
			await sh(`rm -rf -- ${directory} ${outputs}`)
		}
	}, 120_000)

	it("reads and lists what is in the machine", async () => {
		const mount = makeSandboxMount("/workspace", inContainer)
		await sh(
			String.raw`mkdir -p /workspace/m/sub/deep && cd /workspace/m && printf 'hello\n' > a.txt && printf x > sub/b && ln -s a.txt link && ln -s nowhere broken && chmod 640 a.txt && touch -d @1700000000 a.txt`,
		)
		expect(await mount.stat("m/a.txt")).toEqual({
			type: "file",
			size: 6,
			mtime: 1_700_000_000_000,
			mode: 0o640,
		})
		expect((await mount.stat("m"))?.type).toBe("dir")
		expect((await mount.stat(""))?.type).toBe("dir")
		expect((await mount.stat("m/link"))?.size).toBe(6)
		expect(await mount.stat("m/broken")).toBeNull()
		expect(await mount.stat("m/none")).toBeNull()

		expect(names(await mount.readdir("m"))).toEqual(["dir sub", "file a.txt", "file link"])
		const linked = (await mount.readdir("m"))?.find(({ name }) => name === "link")
		expect(linked).toEqual({ name: "link", ...(await mount.stat("m/link")) })
		expect(names(await mount.readdir("m", { recursive: true, limit: 100 }))).toEqual([
			"dir sub",
			"dir sub/deep",
			"file a.txt",
			"file link",
			"file sub/b",
		])
		expect(await mount.readdir("m/none")).toBeNull()
		expect(await codeOf(mount.readdir("m/a.txt"))).toBe("ENOTDIR")
		await expect(mount.readdir("m", { recursive: true, limit: 3 })).rejects.toThrow(
			"holds more than 3 files and directories",
		)
		await sh(
			String.raw`mkdir -p '/workspace/m/back\slash' && touch '/workspace/m/back\slash/in' /workspace/m/-dash $'/workspace/m/new\nline'`,
		)
		expect(names(await mount.readdir("m", { recursive: true, limit: 100 }))).toEqual([
			"dir sub",
			"dir sub/deep",
			"file -dash",
			"file a.txt",
			"file link",
			"file new\nline",
			"file sub/b",
		])
		expect((await mount.stat("m/-dash"))?.type).toBe("file")
		expect((await mount.stat("m/new\nline"))?.type).toBe("file")

		await sh("cd /workspace && ln -s m/sub linked && mkdir walked && ln -s ../m/sub walked/inner")
		expect(names(await mount.readdir("linked"))).toEqual(["dir deep", "file b"])
		expect(names(await mount.readdir("linked", { recursive: true, limit: 100 }))).toEqual([
			"dir deep",
			"file b",
		])
		expect(names(await mount.readdir("walked", { recursive: true, limit: 100 }))).toEqual([
			"dir inner",
		])
		const inner = (await mount.readdir("walked"))?.find(({ name }) => name === "inner")
		expect(inner).toEqual({ name: "inner", ...(await mount.stat("walked/inner")) })

		await sh("mkdir /workspace/crowd && cd /workspace/crowd && seq 1 100001 | xargs touch")
		await expect(mount.readdir("crowd")).rejects.toThrow("holds more than 100000 files")
		await expect(mount.readdir("", { recursive: true })).rejects.toThrow("holds more than 100000")
		await sh("rm -rf /workspace/crowd")
	}, 120_000)

	it("reads a file whole, in part, and across the chunks it asks the machine for", async () => {
		const mount = makeSandboxMount("/workspace", inContainer)
		const bytes = patterned(2 * 1024 * 1024 + 4097)
		await Effect.runPromise(sandbox.writeFile("/workspace/r/big.bin", bytes))
		const whole = await mount.readFile("r/big.bin")
		expect(whole?.stat.size).toBe(bytes.byteLength)
		expect(sha256(await collect(whole?.body ?? new ReadableStream()))).toBe(sha256(bytes))
		const range = async (offset: number, length?: number) => {
			const read = await mount.readFile("r/big.bin", {
				range: { offset, ...(length === undefined ? {} : { length }) },
			})
			expect(read?.offset).toBe(offset)
			return collect(read?.body ?? new ReadableStream())
		}
		sent.length = 0
		expect(await range(1024 * 1024 - 3, 9)).toEqual(
			bytes.subarray(1024 * 1024 - 3, 1024 * 1024 + 6),
		)
		expect(sent.map((command) => command.slice(-2))).toEqual([[String(1024 * 1024 - 2), "9"]])
		expect(await range(bytes.byteLength - 5)).toEqual(bytes.subarray(-5))
		expect(await range(bytes.byteLength - 5, 500)).toEqual(bytes.subarray(-5))
		expect(await range(bytes.byteLength + 10, 5)).toEqual(new Uint8Array())
		expect(await range(7, 1024 * 1024 + 11)).toEqual(bytes.subarray(7, 1024 * 1024 + 18))
		expect(await mount.readFile("r/none")).toBeNull()
		expect(await codeOf(mount.readFile("r"))).toBe("EISDIR")
	}, 120_000)

	it("writes, creates, removes, renames and sets modes in the machine", async () => {
		const mount = makeSandboxMount("/workspace", inContainer)
		const binary = patterned(70_000)
		await mount.writeFile?.("w/new/dir/file.bin", body(binary), { mode: 0o750 })
		expect(await sh("sha256sum < /workspace/w/new/dir/file.bin | cut -d' ' -f1")).toBe(
			`${sha256(binary)}\n`,
		)
		expect(await sh("stat -c %a /workspace/w/new/dir/file.bin")).toBe("750\n")
		await mount.writeFile?.("w/new/dir/file.bin", body(text("replaced")), {})
		expect(await sh("cat /workspace/w/new/dir/file.bin")).toBe("replaced")

		const created = await Promise.all(
			["one", "two"].map((content) =>
				codeOf(
					mount.writeFile?.("w/once.txt", body(text(content)), { exclusive: true }) ??
						Promise.resolve(),
				),
			),
		)
		expect(created.toSorted((a, b) => a.localeCompare(b))).toEqual(["EEXIST", "no error"])
		expect(["one", "two"]).toContain(await sh("cat /workspace/w/once.txt"))
		expect(await sh("ls -A /workspace/w")).toBe("new\nonce.txt\n")

		await mount.mkdir?.("w/a/b/c", { recursive: true })
		await mount.mkdir?.("w/a/b/c", { recursive: true })
		expect(await codeOf(mount.mkdir?.("w/a/b/c", {}) ?? Promise.resolve())).toBe("EIO")
		await mount.chmod?.("w/once.txt", 0o400, {})
		expect(await sh("stat -c %a /workspace/w/once.txt")).toBe("400\n")
		expect(await codeOf(mount.chmod?.("w/none", 0o400, {}) ?? Promise.resolve())).toBe("ENOENT")

		await mount.rename?.("w/once.txt", "w/a/moved.txt", {})
		expect(await sh("ls /workspace/w/a")).toBe("b\nmoved.txt\n")
		expect(await codeOf(mount.rename?.("w/a/moved.txt", "w/a/b", {}) ?? Promise.resolve())).toBe(
			"EIO",
		)
		expect(await codeOf(mount.rename?.("w/none", "w/x", {}) ?? Promise.resolve())).toBe("ENOENT")

		expect(await codeOf(mount.rm?.("w/a", {}) ?? Promise.resolve())).toBe("EISDIR")
		expect(await sh("ls /workspace/w/a")).toBe("b\nmoved.txt\n")
		await sh("mkfifo /workspace/w/pipe")
		const blocked = Date.now()
		expect(
			await codeOf(mount.writeFile?.("w/pipe", body(text("x")), {}) ?? Promise.resolve()),
		).not.toBe("no error")
		expect(Date.now() - blocked).toBeLessThan(10_000)
		await sh("rm /workspace/w/pipe")
		expect(await codeOf(mount.rm?.("w/none", {}) ?? Promise.resolve())).toBe("ENOENT")
		await mount.rm?.("w/a/moved.txt", {})
		await mount.rm?.("w/a", { recursive: true })
		expect(await sh("ls -A /workspace/w")).toBe("new\n")
	}, 120_000)

	it("clones a repository only where its checkout is missing, and leaves nothing behind when a clone fails", async () => {
		await sh(
			"git init -q -b main /srv/origin && git -C /srv/origin -c user.email=a@b -c user.name=a commit -q --allow-empty -m first",
		)
		const mount = {
			id: "sesrsc_1",
			type: "github_repository" as const,
			url: "file:///srv/origin",
			mount_path: "/workspace/repos/api",
			checkout: { type: "branch" as const, name: "main" },
		}
		expect((await clone(mount)).exitCode).toBe(0)
		expect(await sh("git -C /workspace/repos/api branch --show-current")).toBe("main\n")
		await sh("echo edit > /workspace/repos/api/notes.txt")
		expect((await clone(mount)).exitCode).toBe(0)
		expect(await sh("cat /workspace/repos/api/notes.txt")).toBe("edit\n")
		await sh("rm -rf /workspace/repos/api")
		expect((await clone(mount)).exitCode).toBe(0)
		expect(await sh("ls -A /workspace/repos")).toBe("api\n")
		const missing = {
			...mount,
			mount_path: "/workspace/repos/gone",
			checkout: { type: "branch" as const, name: "nope" },
		}
		expect((await clone(missing)).exitCode).not.toBe(0)
		expect((await clone(missing)).exitCode).not.toBe(0)
		expect(await sh("ls -A /workspace/repos")).toBe("api\n")
		const sibling = { ...mount, mount_path: "/workspace/repos/.cloning-web" }
		expect((await clone(sibling)).exitCode).toBe(0)
		await sh("rm -rf /workspace/repos/web")
		expect((await clone({ ...mount, mount_path: "/workspace/repos/web" })).exitCode).toBe(0)
		expect(await sh("ls -A /workspace/repos")).toBe(".cloning-web\napi\nweb\n")
		expect(await sh("stat -c %a /workspace/repos/web")).toBe("755\n")
		await sh("rm -rf /workspace/repos /srv/origin")
	}, 30_000)

	it("runs a command to its end, its limit or its last output, whichever a call can hold", async () => {
		const kept = new Map<string, unknown>()
		const machine = makeWorkspaceMachine({
			sandboxes: { open: () => Effect.succeed(sandbox), remove: () => Effect.void },
			key: "sess_1",
			store: {
				get: <A>(key: string) => kept.get(key) as A | undefined,
				put: (key, value) => {
					kept.set(key, value)
				},
				delete: (key) => {
					kept.delete(key)
				},
			},
			disk: {
				read: () => undefined,
				replace: async (archive) => {
					let bytes = 0
					for await (const chunk of archive.chunks) {
						bytes += chunk.byteLength
					}
					expect(bytes).toBeGreaterThan(0)
				},
			},
			directory: "/workspace/commands",
			stored: storedFiles(new Map([["/workspace/commands", { kind: "dir", mode: 0o755 }]])),
			settled: () => Promise.resolve(),
			touched: () => undefined,
		})
		const run = async (command: string, seconds = 20, cwd = "/workspace") => {
			const result = await machine.command(["bash", "-c", command], { cwd, seconds }, undefined)
			const [part] = result.content
			return { text: part?.type === "text" ? part.text : "", isError: result.isError }
		}
		expect(await run("echo out; echo err >&2; pwd")).toEqual({
			text: "out\nerr\n/workspace",
			isError: false,
		})
		expect(await run("true")).toEqual({ text: "(no output)", isError: false })
		expect(await run("echo partly; exit 7")).toEqual({
			text: "partly\n[Exit code 7.]",
			isError: true,
		})
		expect(await run("git config user.name || git var GIT_AUTHOR_IDENT | cut -d'<' -f1")).toEqual({
			text: "Checkfu",
			isError: false,
		})
		expect((await run("pwd", 20, "/workspace/none")).isError).toBe(true)

		const long = await run("seq 1 200000")
		expect(long.isError).toBe(false)
		expect(long.text.startsWith("[The first ")).toBe(true)
		expect(long.text.endsWith("\n199999\n200000")).toBe(true)
		expect(new TextEncoder().encode(long.text).byteLength).toBeLessThan(50 * 1024)
		expect(long.text.split("\n").length).toBeLessThan(2000)
		const lines = await run("yes | head -n 100000")
		expect(lines.text.split("\n").length).toBeLessThan(2000)

		const started = Date.now()
		expect(await run("echo began; sleep 30", 1)).toEqual({
			text: "began\n[Stopped after 1 seconds.]",
			isError: true,
		})
		expect(await run("sleep 30 & echo started")).toEqual({ text: "started", isError: false })
		expect(Date.now() - started).toBeLessThan(15_000)
		expect(await run("cat; echo done")).toEqual({ text: "done", isError: false })

		expect((await run("rm -rf /workspace/commands && echo gone")).text).toBe("gone")
		expect(await run("pwd", 20, "/workspace/commands")).toEqual({
			text: "/workspace/commands",
			isError: false,
		})
		expect((await run("pwd", 20, "/workspace/none")).isError).toBe(true)
		expect(await sh("[ -e /workspace/none ] && echo made || echo absent")).toBe("absent\n")
		await sh("rm -rf /workspace/commands")
		const root = makeSandboxMount("/workspace/commands", inContainer)
		expect(await root.readdir("")).toEqual([])
		expect(await sh("[ -d /workspace/commands ] && echo there")).toBe("there\n")

		const stopping = new AbortController()
		const ticking = machine.command(
			[
				"bash",
				"-c",
				"(while true; do date >> ticks; sleep 0.1; done) & while true; do sleep 1; done",
			],
			{ cwd: "/workspace/commands", seconds: 120 },
			stopping.signal,
		)
		await pause(1500)
		const stopAt = Date.now()
		stopping.abort()
		const stopped = await ticking
		expect(Date.now() - stopAt).toBeLessThan(10_000)
		expect([stopped.isError, stopped.content.at(-1)]).toEqual([
			true,
			{ type: "text", text: "[Stopped: the turn was interrupted.]" },
		])
		const ticks = await sh("wc -l < /workspace/commands/ticks")
		expect(Number(ticks)).toBeGreaterThan(3)
		await pause(800)
		expect(await sh("wc -l < /workspace/commands/ticks")).toBe(ticks)
		expect(await sh("ls /tmp/checkfu-calls | wc -l")).toBe("0\n")

		await sh("rm -rf /workspace")
		expect(await run("pwd", 20, "/")).toEqual({ text: "/", isError: false })
		expect(await makeSandboxMount("/workspace/commands", inContainer).readdir("")).toEqual([])

		expect(
			(
				await run(
					"setsid bash -c 'while :; do date >> /workspace/commands/daemon.log; sleep 0.05; done' >/dev/null 2>&1 </dev/null & echo started",
					20,
					"/workspace/commands",
				)
			).text,
		).toBe("started")
		await pause(500)
		expect(Number(await sh("wc -l < /workspace/commands/daemon.log"))).toBeGreaterThan(2)
		await machine.sleep()
		const quiet = await sh("wc -l < /workspace/commands/daemon.log")
		await pause(500)
		expect(await sh("wc -l < /workspace/commands/daemon.log")).toBe(quiet)
		await sh("mkdir -p /workspace")

		expect(
			(
				await run(
					"(while true; do date >> busy.log; done) & echo writing",
					20,
					"/workspace/commands",
				)
			).text,
		).toBe("writing")
		await pause(300)
		for await (const chunk of archiveOf(sandbox, "/workspace/commands")) {
			expect(chunk.byteLength).toBeGreaterThan(0)
		}
		const written = await sh("wc -l < /workspace/commands/busy.log")
		await pause(500)
		expect(await sh("wc -l < /workspace/commands/busy.log")).toBe(written)
	}, 120_000)
})
