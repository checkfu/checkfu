import * as Effect from "effect/Effect"
import { createTarPacker } from "modern-tar"
import { TIMED_OUT } from "../Sandbox/Sandboxes.ts"
import type { Sandbox, Sandboxes } from "../Sandbox/Sandboxes.ts"
import type { InSandbox } from "./SandboxMount.ts"
import { inPieces } from "./SavedDisk.ts"
import type { Archive, SavedDisk } from "./SavedDisk.ts"
import { COMMAND_OUTPUT_BYTES, COMMAND_OUTPUT_LINES } from "./WorkspaceTools.ts"
import type { WorkspaceToolResult } from "./WorkspaceTools.ts"

const run = <A, E>(effect: Effect.Effect<A, E>, signal?: AbortSignal): Promise<A> =>
	Effect.runPromise(effect, signal === undefined ? undefined : { signal })

export interface StoredFiles {
	readonly readdir: (path: string) => Promise<
		ReadonlyArray<{
			readonly name: string
			readonly isDirectory: boolean
			readonly isSymbolicLink: boolean
		}>
	>
	readonly lstat: (
		path: string,
	) => Promise<{ readonly mode: number; readonly size: number; readonly mtime: number }>
	readonly readlink: (path: string) => Promise<string>
	readonly readFile: (path: string) => Promise<ReadableStream<Uint8Array>>
}

export async function* packDirectory(
	files: StoredFiles,
	directory: string,
	root: string,
): AsyncGenerator<Uint8Array> {
	const { readable, controller } = createTarPacker()
	const add = async (path: string, prefix: string): Promise<void> => {
		for (const entry of await files.readdir(path)) {
			const at = `${path}/${entry.name}`
			const name = `${prefix}${entry.name}`
			const stat = await files.lstat(at)
			const header = { name, mode: stat.mode & 0o7777, mtime: new Date(stat.mtime) }
			if (entry.isSymbolicLink) {
				const linkname = await files.readlink(at)
				await controller.add({ ...header, type: "symlink", size: 0, linkname }).close()
			} else if (entry.isDirectory) {
				await controller.add({ ...header, type: "directory", size: 0 }).close()
				await add(at, `${name}/`)
			} else {
				const body = await files.readFile(at)
				await body.pipeTo(controller.add({ ...header, type: "file", size: stat.size }))
			}
		}
	}
	const packed = add(
		directory,
		directory === root ? "" : `${directory.slice(root.length + 1)}/`,
	).then(
		() => {
			controller.finalize()
		},
		(error: unknown) => {
			controller.error(error)
		},
	)
	const reader = readable.getReader()
	for (;;) {
		const { done, value } = await reader.read()
		if (done) {
			break
		}
		yield value
	}
	await packed
}

const PART_BYTES = 4 * 1024 * 1024
const UNPACK = `mkdir -p "$2" || exit 1
cat "$1"/* | if [ "$3" = zstd ]; then zstd -dc; else cat; fi | tar -x -C "$2"
for code in "\${PIPESTATUS[@]}"; do [ "$code" -eq 0 ] || exit 1; done`
const CALLS = "/tmp/checkfu-calls"
const COMMAND_MARK = "CHECKFU_COMMAND=1"
const SAVE = `marked() { for env in /proc/[0-9]*/environ; do pid=\${env#/proc/}; tr '\\0' '\\n' <"$env" 2>/dev/null | grep -qx ${COMMAND_MARK} && echo "\${pid%/environ}"; done; }
for signal in STOP STOP KILL; do for pid in $(marked); do kill -"$signal" "$pid" 2>/dev/null; done; done
sleep 0.2
mkdir -p "$1" "$2" && tar -c -C "$1" . | zstd -q -1 | split -b "$3" -a 6 -d - "$2/"
codes=("\${PIPESTATUS[@]}")
[ "\${#codes[@]}" -eq 3 ] && [ "\${codes[0]}" -eq 0 ] && [ "\${codes[1]}" -eq 0 ] && [ "\${codes[2]}" -eq 0 ] || exit 1
ls "$2" | wc -l`
const ARCHIVE_MS = 15 * 60 * 1000

const unstaged = (sandbox: Sandbox, staging: string): Promise<void> =>
	run(sandbox.exec(["rm", "-rf", "--", staging])).then(
		() => undefined,
		() => undefined,
	)

export const unpackInto = async (
	sandbox: Sandbox,
	directory: string,
	archive: Archive,
): Promise<void> => {
	const staging = `/tmp/checkfu-unpack-${crypto.randomUUID()}`
	try {
		let part = 0
		for await (const bytes of inPieces(archive.chunks, PART_BYTES)) {
			await run(sandbox.writeFile(`${staging}/${String(part).padStart(8, "0")}`, bytes))
			part += 1
		}
		const unpacked = await run(
			sandbox.exec(
				["bash", "-c", UNPACK, "bash", staging, directory, archive.compressed ? "zstd" : "plain"],
				{ timeout: ARCHIVE_MS },
			),
		)
		if (unpacked.exitCode !== 0) {
			throw new Error(`Could not unpack ${directory} in the machine: ${unpacked.stderr.trim()}`)
		}
	} finally {
		await unstaged(sandbox, staging)
	}
}

export async function* archiveOf(sandbox: Sandbox, directory: string): AsyncGenerator<Uint8Array> {
	const staging = `/tmp/checkfu-save-${crypto.randomUUID()}`
	try {
		const saved = await run(
			sandbox.exec(["bash", "-c", SAVE, "bash", directory, staging, String(PART_BYTES)], {
				timeout: ARCHIVE_MS,
			}),
		)
		const parts = Number.parseInt(saved.stdout, 10)
		if (saved.exitCode !== 0 || Number.isNaN(parts)) {
			throw new Error(`Could not pack ${directory} in the machine: ${saved.stderr.trim()}`)
		}
		for (let part = 0; part < parts; part += 1) {
			yield await run(sandbox.readFile(`${staging}/${String(part).padStart(6, "0")}`))
		}
	} finally {
		await unstaged(sandbox, staging)
	}
}

const MACHINE = "machine"
interface MachineRecord {
	readonly incarnation?: string
	readonly notice?: string
	readonly starting?: true
}

const REPLACED =
	"The session's machine stopped and a new one took its place. /workspace is as it was when the machine last slept, or as it was before the first command if it never did: changes since then are gone, with every running process and everything outside /workspace. Check the files before you go on."

const COMMAND = `dir=$1; seconds=$2; bytes=$3; lines=$4; call=${CALLS}/$5; root=$6; shift 6
mkdir -p ${CALLS}; [ -e "$call.stop" ] && { rm -f -- "$call.stop"; echo 0 >&2; exit 143; }
[ "$dir" != "$root" ] || mkdir -p -- "$root" 2>/dev/null
work=$(mktemp -d); mkfifo "$work/in" "$work/out"
dd if="$work/in" of="$work/out" bs=65536 2>"$work/total" & copier=$!
tail -c "$bytes" <"$work/out" >"$work/log" & keeper=$!
{ cd "$dir" && ${COMMAND_MARK} exec timeout --kill-after=5 "$seconds" "$@"; } >"$work/in" 2>&1 </dev/null &
pid=$!; echo "$pid" >"$call"
[ -e "$call.stop" ] && { kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null; }
wait "$pid"; code=$?; rm -f -- "$call" "$call.stop"
for try in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$copier" 2>/dev/null || break; sleep 0.1; done
if kill -0 "$copier" 2>/dev/null; then kill -USR1 "$copier"; sleep 0.1; kill -TERM "$copier" 2>/dev/null; fi
wait "$copier"; wait "$keeper"
sed -n '$s/ .*//p' "$work/total" >&2; tail -n "$lines" "$work/log"; rm -rf -- "$work"; exit "$code"`
const STOP = `mkdir -p ${CALLS}; call=${CALLS}/$1; : >"$call.stop"
pid=$(cat "$call" 2>/dev/null) || exit 0
kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null; exit 0`
const INTERRUPTED = "[Stopped: the turn was interrupted.]"
const GRACE_SECONDS = 30

const IDENTITY = {
	GIT_AUTHOR_NAME: "Checkfu",
	GIT_AUTHOR_EMAIL: "agent@checkfu.com",
	GIT_COMMITTER_NAME: "Checkfu",
	GIT_COMMITTER_EMAIL: "agent@checkfu.com",
}

const byteLength = (text: string): number => new TextEncoder().encode(text).byteLength

export interface MachineStore {
	readonly get: <A>(key: string) => A | undefined
	readonly put: (key: string, value: unknown) => void
	readonly delete: (key: string) => void
}

export const makeWorkspaceMachine = (options: {
	readonly sandboxes: (typeof Sandboxes)["Service"]
	readonly key: string
	readonly store: MachineStore
	readonly disk: SavedDisk
	readonly directory: string
	readonly stored: StoredFiles
	readonly settled: () => Promise<void>
	readonly touched: () => void
}) => {
	const record = (): MachineRecord | undefined => options.store.get<MachineRecord>(MACHINE)
	let attached: Sandbox | undefined
	const calls = new Set<Promise<unknown>>()
	let active = 0
	let last: Promise<unknown> = Promise.resolve()
	const inTurn = <A>(work: () => Promise<A>): Promise<A> => {
		const next = last.then(work, work)
		last = next.catch(() => undefined)
		return next
	}

	const abandon = async (): Promise<void> => {
		await run(options.sandboxes.remove(options.key))
		const now = record()
		const kept: MachineRecord = {
			...(now?.incarnation === undefined ? {} : { incarnation: now.incarnation }),
			...(now?.notice === undefined ? {} : { notice: now.notice }),
		}
		if (
			kept.incarnation === undefined &&
			kept.notice === undefined &&
			options.disk.read() === undefined
		) {
			options.store.delete(MACHINE)
		} else {
			options.store.put(MACHINE, kept)
		}
	}

	const settle = async (): Promise<{ readonly sandbox: Sandbox; readonly fresh: boolean }> => {
		const before = record()
		const starting = (): void => {
			options.store.put(MACHINE, { ...before, starting: true } satisfies MachineRecord)
		}
		if (before?.incarnation === undefined) {
			starting()
		}
		try {
			const sandbox = await run(options.sandboxes.open(options.key))
			const fresh = sandbox.incarnation !== before?.incarnation
			if (fresh) {
				starting()
				const saved = options.disk.read()
				if (saved === undefined) {
					await options.settled()
					await unpackInto(sandbox, options.directory, {
						chunks: packDirectory(options.stored, options.directory, options.directory),
						compressed: false,
					})
				} else {
					await unpackInto(sandbox, options.directory, saved)
				}
			}
			const notice = fresh && before?.incarnation !== undefined ? REPLACED : before?.notice
			options.store.put(MACHINE, {
				incarnation: sandbox.incarnation,
				...(notice === undefined ? {} : { notice }),
			} satisfies MachineRecord)
			return { sandbox, fresh }
		} catch (error) {
			if (record()?.starting === true) {
				await abandon().catch(() => undefined)
			}
			throw error
		}
	}

	const rest = async (): Promise<void> => {
		const now = record()
		if (now?.starting === true) {
			await abandon()
			return
		}
		if (now?.incarnation === undefined) {
			return
		}
		attached = undefined
		await Promise.allSettled(calls)
		const { sandbox, fresh } = await settle()
		if (!fresh) {
			await options.disk.replace({
				chunks: archiveOf(sandbox, options.directory),
				compressed: true,
			})
		}
		await run(options.sandboxes.remove(options.key))
		const after = record()
		options.store.put(
			MACHINE,
			(after?.notice === undefined ? {} : { notice: after.notice }) satisfies MachineRecord,
		)
	}

	const attach = (): Promise<Sandbox> =>
		attached === undefined
			? inTurn(async () => {
					attached ??= (await settle()).sandbox
					return attached
				})
			: Promise.resolve(attached)

	const forCall = async (): Promise<Sandbox> => {
		const sandbox = await attach()
		const now = record()
		if (now?.notice !== undefined) {
			options.store.put(MACHINE, { incarnation: now.incarnation })
			throw new Error(now.notice)
		}
		return sandbox
	}

	const inMachine = async <A, E>(
		call: (sandbox: Sandbox) => Effect.Effect<A, E>,
		signal?: AbortSignal,
	): Promise<A> => {
		active += 1
		options.touched()
		try {
			const sandbox = await forCall()
			const running = run(call(sandbox), signal)
			calls.add(running)
			try {
				return await running
			} catch (error) {
				calls.delete(running)
				if (signal?.aborted !== true) {
					attached = undefined
					await forCall()
				}
				throw error
			} finally {
				calls.delete(running)
			}
		} finally {
			active -= 1
			options.touched()
		}
	}

	return {
		inMachine: inMachine satisfies InSandbox,
		engaged: (): boolean => record() !== undefined,
		busy: (): boolean => active > 0,
		command: async (
			argv: ReadonlyArray<string>,
			settings: { readonly cwd: string; readonly seconds: number },
			signal: AbortSignal | undefined,
		): Promise<WorkspaceToolResult> => {
			const interrupted = (): boolean => signal?.aborted === true
			if (interrupted()) {
				return { content: [{ type: "text", text: INTERRUPTED }], isError: true }
			}
			const name = crypto.randomUUID()
			const { exitCode, stdout, stderr } = await inMachine((sandbox) => {
				if (interrupted()) {
					return Effect.succeed({ exitCode: 143, stdout: "", stderr: "0" })
				}
				const stop = (): void => {
					void run(sandbox.exec(["sh", "-c", STOP, "sh", name])).catch(() => undefined)
				}
				signal?.addEventListener("abort", stop, { once: true })
				return Effect.ensuring(
					sandbox.exec(
						[
							"bash",
							"-c",
							COMMAND,
							"bash",
							settings.cwd,
							String(settings.seconds),
							String(COMMAND_OUTPUT_BYTES),
							String(COMMAND_OUTPUT_LINES),
							name,
							options.directory,
							...argv,
						],
						{ env: IDENTITY, timeout: (settings.seconds + GRACE_SECONDS) * 1000 },
					),
					Effect.sync(() => signal?.removeEventListener("abort", stop)),
				)
			})
			const cut = Number.parseInt(stderr, 10) - byteLength(stdout)
			const text = [
				...(cut > 0 ? [`[The first ${cut} bytes of the output are not shown.]`] : []),
				...(stdout.trimEnd() === "" ? [] : [stdout.trimEnd()]),
				...(interrupted()
					? [INTERRUPTED]
					: exitCode === TIMED_OUT
						? [`[Stopped after ${settings.seconds} seconds.]`]
						: exitCode === 0
							? []
							: [`[Exit code ${exitCode}.]`]),
			].join("\n")
			return {
				content: [{ type: "text", text: text || "(no output)" }],
				isError: exitCode !== 0 || interrupted(),
			}
		},
		sleep: (): Promise<boolean> =>
			inTurn(async () => {
				const awake = record()?.incarnation !== undefined
				await rest()
				return awake
			}),
		remove: (): Promise<boolean> =>
			inTurn(async () => {
				if (record() === undefined) {
					return false
				}
				attached = undefined
				await run(options.sandboxes.remove(options.key))
				return true
			}),
	}
}
