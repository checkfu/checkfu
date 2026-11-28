import {
	MachineLifecycle,
	initialMachine,
	machineNoticeRead,
	machineSlept,
	machineStartFailed,
	machineStartRequested,
	machineStarted,
} from "@checkfu/domain/Workspace/MachineLifecycle"
import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import { TIMED_OUT } from "../Sandbox/Sandboxes.ts"
import type { Sandbox, Sandboxes } from "../Sandbox/Sandboxes.ts"
import type { InSandbox, SandboxCallOptions } from "./SandboxMount.ts"
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
	readonly lstat: (path: string) => Promise<{
		readonly mode: number
		readonly size: number
		readonly mtime: number
		readonly isDirectory: boolean
		readonly isSymbolicLink: boolean
	}>
	readonly readlink: (path: string) => Promise<string>
	readonly readFile: (path: string) => Promise<ReadableStream<Uint8Array>>
}

export async function* packDirectories(
	files: StoredFiles,
	directories: ReadonlyArray<string>,
): AsyncGenerator<Uint8Array> {
	const { createTarPacker } = await import("modern-tar")
	const { readable, controller } = createTarPacker()
	const producer = new AbortController()
	const { signal } = producer
	const entry = async (
		at: string,
		name: string,
		directory: boolean,
		link: boolean,
	): Promise<void> => {
		signal.throwIfAborted()
		const stat = await files.lstat(at)
		signal.throwIfAborted()
		const header = { name, mode: stat.mode & 0o7777, mtime: new Date(stat.mtime) }
		if (link) {
			const linkname = await files.readlink(at)
			signal.throwIfAborted()
			await controller.add({ ...header, type: "symlink", size: 0, linkname }).close()
		} else if (directory) {
			await controller.add({ ...header, type: "directory", size: 0 }).close()
			await add(at, `${name}/`)
		} else {
			const body = await files.readFile(at)
			if (signal.aborted) {
				await body.cancel(signal.reason)
				return
			}
			await body.pipeTo(controller.add({ ...header, type: "file", size: stat.size }))
		}
	}
	const add = async (path: string, prefix: string): Promise<void> => {
		signal.throwIfAborted()
		for (const item of await files.readdir(path)) {
			signal.throwIfAborted()
			await entry(
				`${path}/${item.name}`,
				`${prefix}${item.name}`,
				item.isDirectory,
				item.isSymbolicLink,
			)
		}
	}
	const pack = async () => {
		for (const directory of directories) {
			signal.throwIfAborted()
			const stat = await files.lstat(directory).catch((error: unknown) => {
				if (Predicate.hasProperty(error, "code") && error.code === "ENOENT") {
					return undefined
				}
				throw error
			})
			if (stat !== undefined) {
				await entry(
					directory,
					directory.slice(1),
					stat.isDirectory === true,
					stat.isSymbolicLink === true,
				)
			}
		}
		if (!signal.aborted) {
			controller.finalize()
		}
	}
	void pack().catch((error: unknown) => {
		if (!signal.aborted) {
			controller.error(error)
		}
	})
	const reader = readable.getReader()
	try {
		for (;;) {
			const chunk = await reader.read()
			if (chunk.done) {
				return
			}
			yield chunk.value
		}
	} finally {
		producer.abort()
		await reader.cancel().catch(() => undefined)
		reader.releaseLock()
	}
}

const PART_BYTES = 4 * 1024 * 1024
const UNPACK = `cat "$1"/* | if [ "$2" = zstd ]; then zstd -dc; else cat; fi | tar -x -C /
for code in "\${PIPESTATUS[@]}"; do [ "$code" -eq 0 ] || exit 1; done
shift 2
for directory; do
 [ -e "$directory" ] || [ -L "$directory" ] || mkdir -p -- "$directory" || exit 1
done`
const CALLS = "/tmp/checkfu-calls"
const COMMAND_MARK = "CHECKFU_COMMAND=1"
const SAVE = `marked() { for env in /proc/[0-9]*/environ; do pid=\${env#/proc/}; tr '\\0' '\\n' <"$env" 2>/dev/null | grep -qx ${COMMAND_MARK} && echo "\${pid%/environ}"; done; }
for signal in STOP STOP KILL; do for pid in $(marked); do kill -"$signal" "$pid" 2>/dev/null; done; done
sleep 0.2
directory=$1; staging=$2; bytes=$3
mkdir -p -- "$directory" "$staging" || exit 1
paths=("\${directory#/}"); shift 3
for extra; do
	[ -e "$extra" ] || [ -L "$extra" ] || mkdir -p -- "$extra" || exit 1
	paths+=("\${extra#/}")
done
tar -c -C / -- "\${paths[@]}" | zstd -q -1 | split -b "$bytes" -a 6 -d - "$staging/"
codes=("\${PIPESTATUS[@]}")
[ "\${#codes[@]}" -eq 3 ] && [ "\${codes[0]}" -eq 0 ] && [ "\${codes[1]}" -eq 0 ] && [ "\${codes[2]}" -eq 0 ] || exit 1
ls "$staging" | wc -l`
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
	extraDirectories: ReadonlyArray<string> = [],
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
				[
					"bash",
					"-c",
					UNPACK,
					"bash",
					staging,
					archive.compressed ? "zstd" : "plain",
					directory,
					...extraDirectories,
				],
				{
					timeout: ARCHIVE_MS,
				},
			),
		)
		if (unpacked.exitCode !== 0) {
			throw new Error(`Could not unpack ${directory} in the machine: ${unpacked.stderr.trim()}`)
		}
	} finally {
		await unstaged(sandbox, staging)
	}
}

export async function* archiveOf(
	sandbox: Sandbox,
	directory: string,
	extraDirectories: ReadonlyArray<string> = [],
): AsyncGenerator<Uint8Array> {
	const staging = `/tmp/checkfu-save-${crypto.randomUUID()}`
	try {
		const saved = await run(
			sandbox.exec(
				["bash", "-c", SAVE, "bash", directory, staging, String(PART_BYTES), ...extraDirectories],
				{
					timeout: ARCHIVE_MS,
				},
			),
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
const decodeMachine = Schema.decodeUnknownSync(MachineLifecycle)
const REPLACEMENT_NOTICE =
	"The session's machine was replaced. The workspace and outputs were restored from the last sleep, or from before the first command. Later changes, running processes and other files are gone. Check the files before continuing."

const COMMAND = `dir=$1; seconds=$2; bytes=$3; lines=$4; call=${CALLS}/$5; root=$6; shift 6
mkdir -p ${CALLS}; [ -e "$call.stop" ] && { rm -f -- "$call.stop"; echo "0 0" >&2; exit 143; }
[ "$dir" != "$root" ] || mkdir -p -- "$root" 2>/dev/null
work=$(mktemp -d); mkfifo "$work/in" "$work/out"
dd if="$work/in" of="$work/out" bs=65536 2>"$work/total" & copier=$!
tail -c "$bytes" <"$work/out" >"$work/log" & keeper=$!
{ cd "$dir" && ${COMMAND_MARK} exec timeout --verbose --kill-after=5 "$seconds" bash -c 'exec "$@" 2>&1' bash "$@" 2>"$work/deadline"; } >"$work/in" 2>&1 </dev/null &
pid=$!; echo "$pid" >"$call"
[ -e "$call.stop" ] && { kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null; }
wait "$pid" 2>/dev/null; code=$?; rm -f -- "$call" "$call.stop"
for try in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$copier" 2>/dev/null || break; sleep 0.1; done
if kill -0 "$copier" 2>/dev/null; then kill -USR1 "$copier"; sleep 0.1; kill -TERM "$copier" 2>/dev/null; fi
wait "$copier" "$keeper" 2>/dev/null
total=$(sed -n '$s/ .*//p' "$work/total"); deadline=0
[ ! -s "$work/deadline" ] || deadline=1
printf '%s %s\\n' "\${total:-0}" "$deadline" >&2; tail -n "$lines" "$work/log"; rm -rf -- "$work"; exit "$code"`
const STOP = `mkdir -p ${CALLS}; call=${CALLS}/$1; : >"$call.stop"
pid=$(cat "$call" 2>/dev/null) || exit 0
kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null; exit 0`
const INTERRUPTED = "[Stopped: the turn was interrupted.]"
const GRACE_SECONDS = 30
const KILLED_EXIT_CODE = 137

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
	readonly extraDirectories?: ReadonlyArray<string>
	readonly stored: StoredFiles
	readonly settled: () => Promise<void>
	readonly touched: () => void
}) => {
	const extraDirectories = options.extraDirectories ?? []
	const record = (): MachineLifecycle => {
		const stored = options.store.get<unknown>(MACHINE)
		return stored === undefined ? initialMachine : decodeMachine(stored)
	}
	const write = (state: MachineLifecycle): void => {
		if (state.phase === "local") {
			options.store.delete(MACHINE)
		} else {
			options.store.put(MACHINE, state)
		}
	}
	let attached: Sandbox | undefined
	const calls = new Set<Promise<unknown>>()
	let active = 0
	let last: Promise<unknown> = Promise.resolve()
	const inTurn = <A>(work: () => Promise<A>): Promise<A> => {
		const next = last.then(work, work)
		last = next.catch(() => undefined)
		return next
	}

	const abandon = async (previousLost: boolean): Promise<void> => {
		await run(options.sandboxes.remove(options.key))
		const now = record()
		const hasSavedDisk = now.incarnation === "" && !now.notice && options.disk.read() !== undefined
		write(machineStartFailed(now, { hasSavedDisk, previousLost }))
	}

	const settle = async (): Promise<{ readonly sandbox: Sandbox; readonly fresh: boolean }> => {
		const before = record()
		let pending = before
		let previousLost = before.phase === "starting" && before.incarnation !== ""
		const starting = (): void => {
			pending = machineStartRequested(before)
			write(pending)
		}
		if (before.incarnation === "") {
			starting()
		}
		try {
			const sandbox = await run(options.sandboxes.open(options.key))
			const fresh = sandbox.incarnation !== before.incarnation
			if (fresh) {
				previousLost = before.incarnation !== ""
				starting()
				const saved = options.disk.read()
				if (saved === undefined) {
					await options.settled()
					await unpackInto(
						sandbox,
						options.directory,
						{
							chunks: packDirectories(options.stored, [options.directory, ...extraDirectories]),
							compressed: false,
						},
						extraDirectories,
					)
				} else {
					await unpackInto(sandbox, options.directory, saved, extraDirectories)
				}
			}
			write(machineStarted(pending, sandbox.incarnation))
			return { sandbox, fresh }
		} catch (error) {
			if (record().phase === "starting") {
				await abandon(previousLost).catch(() => undefined)
			}
			throw error
		}
	}

	const rest = async (): Promise<void> => {
		const now = record()
		if (now.phase === "starting") {
			await abandon(now.incarnation !== "")
			return
		}
		if (now.incarnation === "") {
			return
		}
		attached = undefined
		await Promise.allSettled(calls)
		const { sandbox, fresh } = await settle()
		if (!fresh) {
			await options.disk.replace({
				chunks: archiveOf(sandbox, options.directory, extraDirectories),
				compressed: true,
			})
		}
		await run(options.sandboxes.remove(options.key))
		write(machineSlept(record()))
	}

	const attach = (signal?: AbortSignal): Promise<Sandbox> =>
		attached === undefined
			? inTurn(async () => {
					signal?.throwIfAborted()
					attached ??= (await settle()).sandbox
					return attached
				})
			: Promise.resolve(attached)

	const forCall = async (signal?: AbortSignal): Promise<Sandbox> => {
		const sandbox = await attach(signal)
		signal?.throwIfAborted()
		const now = record()
		if (now.notice) {
			write(machineNoticeRead(now))
			throw new Error(REPLACEMENT_NOTICE)
		}
		return sandbox
	}

	const inMachine = async <A, E>(
		call: (sandbox: Sandbox) => Effect.Effect<A, E>,
		signal?: AbortSignal,
		access?: SandboxCallOptions,
	): Promise<A> => {
		signal?.throwIfAborted()
		const enter = () => (access?.internal === true ? attach(signal) : forCall(signal))
		active += 1
		options.touched()
		try {
			const sandbox = await enter()
			signal?.throwIfAborted()
			const running = run(call(sandbox), access?.retainOutcome === true ? undefined : signal)
			calls.add(running)
			try {
				return await running
			} catch (error) {
				calls.delete(running)
				if (signal?.aborted !== true) {
					attached = undefined
					await enter()
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
		engaged: (): boolean => record().phase !== "local",
		busy: (): boolean => active > 0,
		command: async (
			argv: ReadonlyArray<string>,
			settings: { readonly cwd: string; readonly seconds: number; readonly internal?: true },
			signal: AbortSignal | undefined,
		): Promise<WorkspaceToolResult> => {
			const interrupted = (): boolean => signal?.aborted === true
			if (interrupted()) {
				return { content: [{ type: "text", text: INTERRUPTED }], isError: true }
			}
			const name = crypto.randomUUID()
			const { exitCode, stdout, stderr } = await inMachine(
				(sandbox) => {
					if (interrupted()) {
						return Effect.succeed({ exitCode: 143, stdout: "", stderr: "0 0" })
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
				},
				undefined,
				settings,
			)
			const cut = Number.parseInt(stderr, 10) - byteLength(stdout)
			const deadline = /^\d+ ([01])$/mu.exec(stderr.trimEnd())?.[1]
			const timedOut =
				(exitCode === TIMED_OUT && deadline !== "0") ||
				(exitCode === KILLED_EXIT_CODE && deadline === "1")
			const text = [
				...(cut > 0 ? [`[The first ${cut} bytes of the output are not shown.]`] : []),
				...(stdout.trimEnd() === "" ? [] : [stdout.trimEnd()]),
				...(interrupted()
					? [INTERRUPTED]
					: timedOut
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
				const awake = record().incarnation !== ""
				await rest()
				return awake
			}),
		remove: (): Promise<boolean> =>
			inTurn(async () => {
				if (record().phase === "local") {
					return false
				}
				attached = undefined
				await run(options.sandboxes.remove(options.key))
				return true
			}),
	}
}
