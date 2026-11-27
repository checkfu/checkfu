import { MAX_ARTIFACT_PATH_LENGTH } from "@checkfu/sdk/Limits"
import * as Base64 from "effect/encoding/Base64"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { OutputEntry } from "./SessionOutputs.ts"
import type { OutputFiles } from "./SessionOutputs.ts"
import type { PassthroughDirent, PassthroughMount, PassthroughStat } from "@cloudflare/computer"
import type * as Effect from "effect/Effect"
import type { Sandbox, SandboxError } from "../Sandbox/Sandboxes.ts"

type FsCode = "EAGAIN" | "EEXIST" | "EIO" | "EISDIR" | "ENOENT" | "ENOTDIR"

const failure = (code: FsCode, message: string): Error =>
	Object.assign(new Error(message), { code })

const MISSING = 44
const WRONG_KIND = 45
const EXISTS = 46

const STAT = `[ -e "$1" ] || exit ${MISSING}; stat -L -c '%f %s %Y' -- "$1"`
const READDIR = `[ -d "$1" ] || { [ -e "$1" ] && exit ${WRONG_KIND}; exit ${MISSING}; }
find -L "$1" -mindepth 1 -maxdepth "$2" \\( -xtype l -type d -prune -printf '%y\\0%s\\0%Ts\\0%m\\0%P\\0' \\) -o -printf '%y\\0%s\\0%Ts\\0%m\\0%P\\0' | head -z -n "$3" | head -c "$4"`
const READ = `[ -f "$1" ] || { [ -e "$1" ] && exit ${WRONG_KIND}; exit ${MISSING}; }
stat -L -c '%f %s %Y' -- "$1" >&2; tail -c "+$2" -- "$1" | head -c "$3" | base64 -w0`
const PLACE_NEW = `ln -T -- "$1" "$2" 2>/dev/null; made=$?; rm -f -- "$1"; [ "$made" -eq 0 ] || exit ${EXISTS}`
const RM = `[ -e "$1" ] || [ -L "$1" ] || exit ${MISSING}
[ "$2" = recursive ] && exec rm -r -f -- "$1"
rm -f -- "$1" 2>/dev/null && exit 0
[ -d "$1" ] && [ ! -L "$1" ] && exit ${WRONG_KIND}
rm -f -- "$1"`
const RENAME = `[ -e "$1" ] || [ -L "$1" ] || exit ${MISSING}; mv -T -- "$1" "$2"`

const FILE_KIND = 8
const DIRECTORY_KIND = 4

const statOf = (line: string): PassthroughStat | null => {
	const [rawMode = "", size = "", seconds = ""] = line.trim().split(" ")
	const mode = Number.parseInt(rawMode, 16)
	const kind = mode >> 12
	return kind !== FILE_KIND && kind !== DIRECTORY_KIND
		? null
		: {
				type: kind === FILE_KIND ? "file" : "dir",
				size: Number(size),
				mtime: Number(seconds) * 1000,
				mode: mode & 0o7777,
			}
}

const READ_CHUNK_BYTES = 1024 * 1024

const LISTING_ENTRIES = 100_000
const LISTING_BYTES = 16 * 1024 * 1024

const byteLength = (text: string): number => new TextEncoder().encode(text).byteLength

const bytesOf = async (body: ReadableStream<Uint8Array>): Promise<Uint8Array> =>
	new Uint8Array(await new Response(body).arrayBuffer())

const fromBase64 = (text: string): Uint8Array<ArrayBuffer> => {
	const decoded = Base64.decode(text)
	if (Result.isFailure(decoded)) {
		throw failure("EIO", "The machine returned invalid base64 file contents.")
	}
	return new Uint8Array(decoded.success)
}

const atRoot = (rel: string, script: string): string =>
	rel === "" ? `mkdir -p -- "$1" 2>/dev/null; ${script}` : script

export type InSandbox = <A>(
	call: (sandbox: Sandbox) => Effect.Effect<A, SandboxError>,
) => Promise<A>

export const makeSandboxMount = (root: string, inSandbox: InSandbox): PassthroughMount => {
	const at = (rel: string): string => (rel === "" ? root : `${root}/${rel}`)
	const run = (script: string, ...args: ReadonlyArray<string>) =>
		inSandbox((sandbox) => sandbox.exec(["sh", "-c", script, "sh", ...args]))
	const done = async (script: string, ...args: ReadonlyArray<string>): Promise<number> => {
		const { exitCode, stderr } = await run(script, ...args)
		if (exitCode !== 0 && exitCode !== MISSING && exitCode !== WRONG_KIND && exitCode !== EXISTS) {
			throw failure("EIO", stderr.trim() || `exit code ${exitCode}`)
		}
		return exitCode
	}
	const absent = (rel: string): Error => failure("ENOENT", `No such file or directory: ${at(rel)}`)

	const chunk = async (rel: string, offset: number, length: number) => {
		const { exitCode, stdout, stderr } = await run(
			READ,
			at(rel),
			String(offset + 1),
			String(length),
		)
		if (exitCode === MISSING) {
			return null
		}
		if (exitCode === WRONG_KIND) {
			throw failure("EISDIR", `Is a directory: ${at(rel)}`)
		}
		const stat = statOf(stderr)
		if (exitCode !== 0 || stat === null) {
			throw failure("EIO", stderr.trim() || `exit code ${exitCode}`)
		}
		return { stat, bytes: fromBase64(stdout) }
	}

	return {
		kind: "checkfu-sandbox",
		strategy: "passthrough",
		mode: "read-write",
		stat: async (rel) => {
			const { exitCode, stdout, stderr } = await run(atRoot(rel, STAT), at(rel))
			if (exitCode === MISSING) {
				return null
			}
			if (exitCode !== 0) {
				throw failure("EIO", stderr.trim() || `exit code ${exitCode}`)
			}
			return statOf(stdout)
		},
		readdir: async (rel, options) => {
			const limit = Math.min(options?.limit ?? LISTING_ENTRIES, LISTING_ENTRIES)
			const { exitCode, stdout, stderr } = await run(
				atRoot(rel, READDIR),
				at(rel),
				options?.recursive === true ? "1000000" : "1",
				String((limit + 1) * 5),
				String(LISTING_BYTES),
			)
			if (exitCode === MISSING) {
				return null
			}
			if (exitCode === WRONG_KIND) {
				throw failure("ENOTDIR", `Not a directory: ${at(rel)}`)
			}
			if (exitCode !== 0) {
				throw failure("EIO", stderr.trim() || `exit code ${exitCode}`)
			}
			const fields = stdout.split("\0")
			if (fields.length > limit * 5 + 1 || byteLength(stdout) >= LISTING_BYTES) {
				throw failure(
					"EIO",
					`${at(rel)} holds more than ${limit} files and directories, or more names than one call lists. Ask for a narrower path, or list them with a command.`,
				)
			}
			const entries: Array<PassthroughDirent> = []
			for (let index = 0; index + 4 < fields.length; index += 5) {
				const kind = fields[index]
				const name = fields[index + 4] ?? ""
				if ((kind === "f" || kind === "d") && !name.includes("\\")) {
					entries.push({
						name,
						type: kind === "f" ? "file" : "dir",
						size: Number(fields[index + 1]),
						mtime: Math.round(Number(fields[index + 2]) * 1000),
						mode: Number.parseInt(fields[index + 3] ?? "", 8),
					})
				}
			}
			return entries
		},
		readFile: async (rel, options) => {
			const offset = options?.range?.offset ?? 0
			const first = await chunk(
				rel,
				offset,
				Math.min(options?.range?.length ?? READ_CHUNK_BYTES, READ_CHUNK_BYTES),
			)
			if (first === null) {
				return null
			}
			const end = Math.min(
				first.stat.size,
				options?.range?.length === undefined ? first.stat.size : offset + options.range.length,
			)
			let next = offset
			return {
				stat: first.stat,
				offset,
				body: new ReadableStream<Uint8Array>({
					pull: async (controller) => {
						if (next >= end) {
							controller.close()
							return
						}
						const length = Math.min(READ_CHUNK_BYTES, end - next)
						const read = next === offset ? first : await chunk(rel, next, length)
						const bytes = read?.bytes.subarray(0, length)
						if (bytes === undefined || bytes.byteLength === 0) {
							controller.close()
							return
						}
						next += bytes.byteLength
						controller.enqueue(bytes)
					},
				}),
			}
		},
		writeFile: async (rel, body, options) => {
			const content = await bytesOf(body)
			const write = (path: string) => inSandbox((sandbox) => sandbox.writeFile(path, content))
			if (options.exclusive === true) {
				const staged = `${at(rel)}.${crypto.randomUUID()}.new`
				await write(staged)
				if ((await done(PLACE_NEW, staged, at(rel))) === EXISTS) {
					throw failure("EEXIST", `File exists: ${at(rel)}`)
				}
			} else {
				await write(at(rel))
			}
			if (options.mode !== undefined) {
				await done('chmod "$2" -- "$1"', at(rel), options.mode.toString(8))
			}
		},
		mkdir: async (rel, options) => {
			await done(options.recursive === true ? 'mkdir -p -- "$1"' : 'mkdir -- "$1"', at(rel))
		},
		rm: async (rel, options) => {
			const outcome = await done(RM, at(rel), options.recursive === true ? "recursive" : "")
			if (outcome === MISSING) {
				throw absent(rel)
			}
			if (outcome === WRONG_KIND) {
				throw failure("EISDIR", `Is a directory: ${at(rel)}`)
			}
		},
		rename: async (from, to) => {
			if ((await done(RENAME, at(from), at(to))) === MISSING) {
				throw absent(from)
			}
		},
		chmod: async (rel, mode) => {
			await done(
				`[ -e "$1" ] || exit ${MISSING}; chmod "$2" -- "$1"`,
				at(rel),
				mode.toString(8),
			).then((outcome) => {
				if (outcome === MISSING) {
					throw absent(rel)
				}
			})
		},
	}
}

const OUTPUT_CHANGED = 47
const decodeOutputs = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(OutputEntry)))

// The machine uses Linux. openat2 resolves the whole path underneath the held directory,
// even while another process changes names. Open only regular, singly linked files for reading.
const CAPTURE_OUTPUT = `
import base64, ctypes, errno, json, os, stat, sys

class OpenHow(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint64) for name in ("flags", "mode", "resolve")]

libc = ctypes.CDLL(None, use_errno=True)
sys_openat2 = 437  # Linux x86-64 and arm64
no_symlinks = 0x04
beneath = 0x08
no_xdev = 0x01
dir_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC

def under(parent, path, flags, resolve):
    how = OpenHow(flags, 0, resolve)
    fd = libc.syscall(sys_openat2, parent, os.fsencode(path), ctypes.byref(how), ctypes.sizeof(how))
    if fd < 0:
        number = ctypes.get_errno()
        raise OSError(number, os.strerror(number))
    return fd

def directory_state(metadata):
    return metadata.st_dev, metadata.st_ino, metadata.st_mtime_ns, metadata.st_ctime_ns

def list_outputs(root, limit, max_path):
    entries = []
    def walk(directory, prefix, expected):
        before = directory_state(os.fstat(directory))
        if expected is not None and before != directory_state(expected):
            sys.exit(${OUTPUT_CHANGED})
        with os.scandir(directory) as children:
            for child in children:
                path = prefix + child.name
                metadata = child.stat(follow_symlinks=False)
                if stat.S_ISDIR(metadata.st_mode):
                    kind = "dir"
                elif stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1:
                    kind = "file"
                else:
                    kind = "other"
                entries.append({"path": path, "type": kind})
                if len(entries) >= limit:
                    return
                if kind == "dir" and len(path) <= max_path:
                    nested = under(root, path, dir_flags, beneath | no_symlinks | no_xdev)
                    try:
                        walk(nested, path + "/", metadata)
                    finally:
                        os.close(nested)
                    if len(entries) >= limit:
                        return
        if directory_state(os.fstat(directory)) != before:
            sys.exit(${OUTPUT_CHANGED})
    walk(root, "", None)
    print(json.dumps(entries, ensure_ascii=True))

def read_output(root, path, limit):
    handle = under(root, path, os.O_PATH | os.O_CLOEXEC, beneath | no_symlinks | no_xdev)
    try:
        before = os.fstat(handle)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            sys.exit(${WRONG_KIND})
        fd = os.open("/proc/self/fd/" + str(handle), os.O_RDONLY | os.O_CLOEXEC)
        try:
            content = bytearray()
            while len(content) < limit:
                chunk = os.read(fd, limit - len(content))
                if not chunk:
                    break
                content.extend(chunk)
            after = os.fstat(fd)
            if (len(content) != min(before.st_size, limit)
                or before.st_size != after.st_size
                or before.st_mtime_ns != after.st_mtime_ns
                or before.st_ctime_ns != after.st_ctime_ns
                or after.st_nlink != 1):
                sys.exit(${OUTPUT_CHANGED})
            sys.stdout.buffer.write(base64.b64encode(content))
        finally:
            os.close(fd)
    finally:
        os.close(handle)

if os.uname().machine not in ("x86_64", "aarch64"):
    raise RuntimeError("Output capture requires Linux x86-64 or arm64.")
mode, path, limit, arg = sys.argv[1:]
base = os.open("/", dir_flags)
try:
    root = under(base, path.lstrip("/"), dir_flags, beneath | no_symlinks)
except FileNotFoundError:
    sys.exit(${MISSING})
except OSError as error:
    if error.errno in (errno.ENOTDIR, errno.ELOOP):
        sys.exit(${WRONG_KIND})
    raise
finally:
    os.close(base)
try:
    if mode == "list":
        list_outputs(root, int(limit), int(arg))
    else:
        read_output(root, arg, int(limit))
except OSError as error:
    if error.errno in (errno.ENOENT, errno.ENOTDIR, errno.ELOOP, errno.EXDEV, errno.EAGAIN):
        sys.exit(${OUTPUT_CHANGED})
    raise
finally:
    os.close(root)
`

export const makeSandboxOutputFiles = (root: string, inSandbox: InSandbox): OutputFiles => {
	const capture = async (mode: "list" | "read", limit: number, argument: string) => {
		const { exitCode, stdout, stderr } = await inSandbox((sandbox) =>
			sandbox.exec([
				"/usr/bin/python3",
				"-I",
				"-c",
				CAPTURE_OUTPUT,
				mode,
				root,
				String(limit),
				argument,
			]),
		)
		switch (exitCode) {
			case 0:
				return stdout
			case MISSING:
				throw failure("ENOENT", "Output directory is missing.")
			case WRONG_KIND:
				throw failure("ENOTDIR", "The output path must use regular files and directories.")
			case OUTPUT_CHANGED:
				throw failure("EAGAIN", "The output directory changed during capture.")
			default:
				throw failure("EIO", stderr.trim() || `Output capture failed with exit code ${exitCode}.`)
		}
	}
	return {
		list: async (limit) =>
			decodeOutputs(await capture("list", limit, String(MAX_ARTIFACT_PATH_LENGTH))),
		read: async (path, limit) => fromBase64(await capture("read", limit, path)),
	}
}
