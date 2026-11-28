import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { chmod, lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { unpackTar } from "modern-tar"
import { readResponseBytes } from "./ResponseBytes.ts"

export const REVISION = /^[a-f0-9]{40}$/
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const RUNTIME_MODE = 0o700

export interface Distribution {
	readonly revision: string
	readonly source: (revision: string, signal: AbortSignal) => Promise<Uint8Array>
	readonly download: (url: string, signal: AbortSignal) => Promise<Uint8Array>
}

const bytes = async (response: Response, limit: number): Promise<Uint8Array> => {
	if (!response.ok) {
		throw new Error(
			`Download failed (HTTP ${response.status}). Retry when the service is available.`,
		)
	}
	if (response.body === null) {
		throw new Error("Download returned an empty response.")
	}
	return readResponseBytes(response.body, limit)
}

export const makeGithubDistribution = (
	revision: string,
	request: typeof fetch = fetch,
): Distribution => {
	const download: Distribution["download"] = async (url, signal) =>
		bytes(
			await request(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]) }),
			150 * 1024 * 1024,
		)
	return {
		revision,
		source: (revision, signal) =>
			download(`https://codeload.github.com/checkfu/checkfu/tar.gz/${revision}`, signal),
		download,
	}
}

/** No links, absolute paths, traversal, device entries, or executable archive modes. */
export const extract = async (archive: Uint8Array, directory: string): Promise<void> => {
	const expanded = await bytes(
		new Response(
			new Blob([Uint8Array.from(archive)]).stream().pipeThrough(new DecompressionStream("gzip")),
		),
		400 * 1024 * 1024,
	)
	const entries = await unpackTar(expanded)
	const seen = new Set<string>()
	let prefix: string | undefined
	for (const { header, data } of entries) {
		const parts = header.name.replace(/\/$/, "").split("/")
		prefix ??= parts[0]
		if (
			parts[0] !== prefix ||
			parts.some(
				(part) =>
					!part ||
					part === "." ||
					part === ".." ||
					part.includes("\\") ||
					part.includes(":") ||
					part.includes("\0"),
			)
		) {
			throw new Error("Unsafe deployment archive path.")
		}
		if (header.type !== "file" && header.type !== "directory") {
			throw new Error("Unsupported deployment archive entry.")
		}
		if (parts.length === 1 && header.type === "directory") {
			continue
		}
		if (parts.length < 2 || seen.has(header.name)) {
			throw new Error("Duplicate or invalid deployment archive entry.")
		}
		seen.add(header.name)
		const file = join(directory, ...parts.slice(1))
		if (header.type === "directory") {
			await mkdir(file, { recursive: true, mode: 0o700 })
		} else {
			await mkdir(dirname(file), { recursive: true, mode: 0o700 })
			await writeFile(file, data ?? new Uint8Array(), { flag: "wx", mode: 0o600 })
		}
	}
}

export interface RuntimeSpec {
	readonly version: string
	readonly targets: Readonly<Record<string, { readonly url: string; readonly integrity: string }>>
}

export const installRuntime = async (
	root: string,
	spec: RuntimeSpec,
	target: string,
	distribution: Distribution,
	signal: AbortSignal,
): Promise<string> => {
	const selected = spec.targets[target]
	if (selected === undefined) {
		throw new Error(
			`Managed deployment does not support ${target}. Use macOS or Linux on arm64 or x64.`,
		)
	}
	if (
		!/^\d+\.\d+\.\d+$/.test(spec.version) ||
		!selected.url.startsWith("https://registry.npmjs.org/@oven/") ||
		!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(selected.integrity)
	) {
		throw new Error("Invalid deployment runtime manifest.")
	}
	const runtimeRoot = join(root, `bun-${spec.version}-${target}`)
	const executable = join(runtimeRoot, "bin", "bun")
	if (await readyRuntime(runtimeRoot, executable, selected.integrity)) {
		return executable
	}
	await rm(runtimeRoot, { force: true, recursive: true })
	const temporary = `${runtimeRoot}.partial`
	await rm(temporary, { recursive: true, force: true })
	try {
		const archive = await distribution.download(selected.url, signal)
		if (`sha512-${createHash("sha512").update(archive).digest("base64")}` !== selected.integrity) {
			throw new Error("Deployment runtime failed its integrity check. Nothing was executed.")
		}
		await extract(archive, temporary)
		const binary = join(temporary, "bin", "bun")
		await chmod(binary, RUNTIME_MODE)
		await writeFile(join(temporary, "sha256"), digest(await readFile(binary)), { mode: 0o600 })
		await writeFile(join(temporary, "integrity"), selected.integrity, { mode: 0o600 })
		await rename(temporary, runtimeRoot)
		return executable
	} finally {
		await rm(temporary, { force: true, recursive: true })
	}
}

const readyRuntime = async (runtimeRoot: string, executable: string, integrity: string) => {
	try {
		if (
			!(await lstat(runtimeRoot)).isDirectory() ||
			!(await lstat(dirname(executable))).isDirectory() ||
			(await readFile(join(runtimeRoot, "integrity"), "utf8")) !== integrity
		) {
			return false
		}
		const expected = (await readFile(join(runtimeRoot, "sha256"), "utf8")).trim()
		if (!/^[a-f0-9]{64}$/.test(expected)) {
			return false
		}
		const file = await open(
			executable,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		)
		try {
			const stat = await file.stat()
			if (!stat.isFile() || stat.nlink !== 1 || digest(await file.readFile()) !== expected) {
				return false
			}
			if ((stat.mode & 0o7777) !== RUNTIME_MODE) {
				await file.chmod(RUNTIME_MODE)
			}
			return true
		} finally {
			await file.close()
		}
	} catch (error) {
		if (
			error instanceof Error &&
			"code" in error &&
			(error.code === "ENOENT" || error.code === "ELOOP")
		) {
			return false
		}
		throw error
	}
}
