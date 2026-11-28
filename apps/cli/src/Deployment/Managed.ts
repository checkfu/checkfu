import { spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { delimiter, dirname, join } from "node:path"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { CheckoutResolver, DEFAULT_STAGE } from "../Commands/Deploy.ts"
import type { CheckoutRequest, ResolveCheckout } from "../Commands/Deploy.ts"
import { configError } from "../Errors.ts"
import type { CliFailure } from "../Errors.ts"
import { configDirectory } from "../SavedConnection.ts"
import { extract, installRuntime, REVISION } from "./Distribution.ts"
import type { Distribution } from "./Distribution.ts"
import { STAGE_PATTERN, stagePathComponent } from "./Stage.ts"

const decodeRevision = Schema.decodeUnknownSync(Schema.Struct({ revision: Schema.String }))
const decodeActive = Schema.decodeUnknownSync(Schema.Struct({ stage: Schema.String }))
const decodeManifest = Schema.decodeUnknownSync(
	Schema.Struct({
		protocol: Schema.Literal(1),
		runtime: Schema.Struct({
			version: Schema.String,
			targets: Schema.Record(
				Schema.String,
				Schema.Struct({ url: Schema.String, integrity: Schema.String }),
			),
		}),
	}),
)
const decodeIntegrity = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.String))
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const missing = (error: unknown) =>
	error instanceof Error && "code" in error && error.code === "ENOENT"

const readJson = async <A>(file: string, decode: (value: unknown) => A): Promise<A> =>
	decode(JSON.parse(await readFile(file, "utf8")))

const readManifest = async (file: string) => {
	try {
		return await readJson(file, decodeManifest)
	} catch (error) {
		if (Schema.isSchemaError(error)) {
			throw new Error(
				"This server deployment definition is not supported by this CLI. Update with `npm install -g checkfu@latest` and retry.",
				{ cause: error },
			)
		}
		throw error
	}
}

export const writeJson = async (file: string, value: unknown): Promise<void> => {
	await mkdir(dirname(file), { recursive: true, mode: 0o700 })
	const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`
	try {
		await writeFile(temporary, `${JSON.stringify(value, null, "\t")}\n`, {
			mode: 0o600,
			flag: "wx",
		})
		await rename(temporary, file)
	} finally {
		await rm(temporary, { force: true })
	}
}

/** The lock spans resolution, installation, Alchemy, readiness, and saving the connection. */
export const acquireOperation = async (directory: string): Promise<() => Promise<void>> => {
	await mkdir(directory, { recursive: true, mode: 0o700 })
	const file = join(directory, "operation.lock")
	let handle
	try {
		handle = await open(file, "wx", 0o600)
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
			throw error
		}
		throw new Error(
			`Another Checkfu deployment operation holds ${file}. Wait for it to finish. If it was forcibly killed, confirm it is no longer running before removing that lock file.`,
			{ cause: error },
		)
	}
	try {
		await handle.writeFile(JSON.stringify({ pid: process.pid }))
	} catch (error) {
		await rm(file, { force: true })
		throw error
	} finally {
		await handle.close()
	}
	return () => rm(file, { force: true })
}

export const installDependencies = (
	runtime: string,
	root: string,
	env: NodeJS.ProcessEnv,
	signal: AbortSignal,
	force = false,
): Promise<void> =>
	new Promise((resolve, reject) => {
		const child = spawn(
			runtime,
			[
				"--no-env-file",
				"install",
				"--frozen-lockfile",
				"--ignore-scripts",
				...(force ? ["--force"] : []),
			],
			{
				cwd: root,
				env,
				stdio: ["ignore", "inherit", "inherit"],
				signal,
				timeout: 180_000,
			},
		)
		let failure: Error | undefined
		child.once("error", (error) => {
			failure = error
		})
		child.once("close", (code) =>
			failure !== undefined
				? reject(failure)
				: code === 0
					? resolve()
					: reject(
							new Error(
								`Deployment dependency installation did not finish (exit ${code}). Retry this command.`,
							),
						),
		)
	})

const fingerprint = async (root: string): Promise<Record<string, string>> => {
	const entries = await readdir(root, { recursive: true, withFileTypes: true })
	const files: Record<string, string> = {}
	for (const entry of entries) {
		if (entry.isSymbolicLink()) {
			throw new Error("Links are not supported in the deployment source.")
		}
		if (entry.isFile()) {
			const file = join(entry.parentPath, entry.name)
			files[file.slice(root.length + 1)] = hash(await readFile(file))
		}
	}
	return files
}

const sourceIsValid = async (root: string): Promise<boolean> => {
	try {
		const files = await readJson(join(root, ".checkfu", "integrity.json"), decodeIntegrity)
		if (!files["alchemy.run.ts"] || !files["bun.lock"] || !files["checkfu.deployment.json"]) {
			return false
		}
		for (const [name, expected] of Object.entries(files)) {
			if (
				name.split(/[\\/]/).some((segment) => !segment || segment === "." || segment === "..") ||
				!/^[a-f0-9]{64}$/.test(expected)
			) {
				return false
			}
			if (hash(await readFile(join(root, name))) !== expected) {
				return false
			}
		}
		return true
	} catch (error) {
		if (missing(error) || error instanceof SyntaxError || Schema.isSchemaError(error)) {
			return false
		}
		throw error
	}
}

const statIfPresent = (path: string) =>
	stat(path).catch((error: unknown) => {
		if (missing(error)) {
			return null
		}
		throw error
	})

export interface ManagedOptions {
	readonly distribution: Distribution
	readonly target: string
	readonly env: NodeJS.ProcessEnv
	readonly install: typeof installDependencies
	readonly announce: (message: string) => void
}

export const prepareManaged = async (
	directory: string,
	request: CheckoutRequest,
	options: ManagedOptions,
	signal: AbortSignal,
) => {
	const base = join(directory, "deploy")
	let stage = request.stage
	if (request.operation === "destroy" && stage === undefined) {
		throw new Error(
			"Name the stage to delete: `checkfu destroy --stage <name>`. Destroy permanently deletes its data. To update, run `checkfu deploy` instead.",
		)
	}
	if (stage === undefined) {
		try {
			stage = (await readJson(join(base, "active.json"), decodeActive)).stage
		} catch (error) {
			if (!missing(error)) {
				throw error
			}
		}
	}
	stage ??= DEFAULT_STAGE
	if (!STAGE_PATTERN.test(stage)) {
		throw new Error("Invalid deployment stage. Nothing was changed.")
	}
	const dataRoot = join(base, "stages", stagePathComponent(stage))
	const revisionFile = join(dataRoot, ".checkfu", "revision.json")
	let revision: string
	if (request.operation === "destroy") {
		try {
			revision = (await readJson(revisionFile, decodeRevision)).revision
		} catch (error) {
			if (missing(error)) {
				throw new Error(`This CLI has no record of deploying "${stage}". Nothing was deleted.`, {
					cause: error,
				})
			}
			throw error
		}
	} else {
		revision = options.distribution.revision
	}
	if (!REVISION.test(revision)) {
		throw new Error("Invalid deployment revision. Nothing was changed.")
	}
	const root = join(base, "sources", revision)
	await mkdir(dirname(root), { recursive: true, mode: 0o700 })
	if (!(await sourceIsValid(root))) {
		options.announce(`Preparing Checkfu ${revision.slice(0, 12)}…`)
		const temporary = `${root}.partial`
		await rm(temporary, { force: true, recursive: true })
		try {
			await extract(await options.distribution.source(revision, signal), temporary)
			const files = await fingerprint(temporary)
			await writeJson(join(temporary, ".checkfu", "integrity.json"), files)
			await writeJson(join(temporary, ".checkfu", "source.json"), {
				revision,
				baseline_sha256: files["apps/api/test/persisted/Persisted.lock.json"],
			})
			// Validate the supported deployment protocol before executing downloaded code.
			await readManifest(join(temporary, "checkfu.deployment.json"))
			await rm(root, { force: true, recursive: true })
			await rename(temporary, root)
		} finally {
			await rm(temporary, { force: true, recursive: true })
		}
	}
	const manifest = await readManifest(join(root, "checkfu.deployment.json"))
	const runtime = await installRuntime(
		join(base, "runtimes"),
		manifest.runtime,
		options.target,
		options.distribution,
		signal,
	)
	const marker = join(root, ".checkfu", "installed")
	const modules = join(root, "node_modules")
	const entry = join(modules, "alchemy", "bin", "cli.js")
	const hasEntry = async () => (await statIfPresent(entry))?.isFile() === true
	const marked = await readFile(marker, "utf8").catch((error: unknown) => {
		if (missing(error)) {
			return ""
		}
		throw error
	})
	if (marked !== "1\n" || !(await hasEntry())) {
		await rm(marker, { force: true })
		options.announce("Installing deployment dependencies (no global tools required)…")
		await options.install(
			runtime,
			root,
			options.env,
			signal,
			(await statIfPresent(modules)) !== null,
		)
		if (!(await hasEntry())) {
			throw new Error("Installation did not produce the Alchemy CLI. Retry this command.")
		}
		await writeFile(marker, "1\n", { mode: 0o600 })
	}
	options.announce(
		`${request.operation === "destroy" ? "Using recorded" : "Deploying"} source ${revision} (stage ${stage}).`,
	)
	return {
		root,
		dataRoot,
		runtime,
		environment: {
			...options.env,
			PATH: [dirname(runtime), options.env.PATH].filter(Boolean).join(delimiter),
		},
		stage,
		revision,
		record: async () => {
			await writeJson(revisionFile, { revision })
			await writeJson(join(base, "active.json"), { stage })
		},
	}
}

/** Keep caller-provided preload/configuration hooks out of the managed runtime. */
export const managedEnvironment = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
	Object.fromEntries(
		Object.entries(env).filter(
			([name]) =>
				![
					"BUN_OPTIONS",
					"BUN_RUNTIME_TRANSPILER_CACHE_PATH",
					"BUN_INSTALL",
					"NODE_OPTIONS",
					"NODE_PATH",
					"BUN_BE_BUN",
				].includes(name),
		),
	)

const attempt = <A>(run: (signal: AbortSignal) => Promise<A>) =>
	Effect.callback<A, CliFailure>((resume, signal) => {
		const pending = run(signal).then(
			(value) => resume(Effect.succeed(value)),
			(error: unknown) =>
				resume(Effect.fail(configError(error instanceof Error ? error.message : String(error)))),
		)
		// Finish asynchronous cleanup before releasing the operation lock on cancellation.
		return Effect.promise(() => pending)
	})

export const makeManagedResolver =
	(options: ManagedOptions): ResolveCheckout =>
	(request) =>
		Effect.gen(function* () {
			const directory = yield* configDirectory
			if (Option.isNone(directory)) {
				return yield* configError(
					"Cannot locate a config directory. Set CHECKFU_CONFIG_DIR to an absolute path.",
				)
			}

			yield* Effect.acquireRelease(
				attempt(() => acquireOperation(join(directory.value, "deploy"))),
				(release) => Effect.promise(release).pipe(Effect.ignore),
			)
			const installed = yield* attempt((signal) =>
				prepareManaged(directory.value, request, options, signal),
			)
			return {
				root: installed.root,
				dataRoot: installed.dataRoot,
				stage: installed.stage,
				runtime: installed.runtime,
				runtimeEnv: { CHECKFU_MANAGED_DEPLOYMENT: "1" },
				environment: installed.environment,
				readyWithin: "3 minutes",
				managed: true,
				recordStage: () => attempt(() => installed.record()),
			}
		})

export { CheckoutResolver }
