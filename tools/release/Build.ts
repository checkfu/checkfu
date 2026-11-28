import * as Schema from "effect/Schema"
import { unpackTar } from "modern-tar"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { gunzipSync } from "node:zlib"

export const repoRoot = fileURLToPath(new URL("../../", import.meta.url))
export const releaseRoot = join(repoRoot, "dist", "npm")

export const BUILD_CREDENTIAL_SENTINEL = "ck_packaging_must_never_embed_credentials"
const CANDIDATE_RECORD = "candidates.json"
const QUALIFIED_RECORD = "qualified.json"
const CANDIDATE_ENV = "CHECKFU_RELEASE_CANDIDATES"
const CANDIDATE_INTEGRITY_ENV = "CHECKFU_RELEASE_CANDIDATES_INTEGRITY"
const PACKAGE_IDENTITIES = ["checkfu", "@checkfu/sdk"] as const
const PackageIdentity = Schema.Literals(PACKAGE_IDENTITIES)
const Candidate = Schema.Struct({
	name: PackageIdentity,
	version: Schema.String,
	filename: Schema.String,
	size: Schema.Int.check(Schema.isGreaterThan(0)),
	integrity: Schema.String,
})
type Candidate = typeof Candidate.Type
const Candidates = Schema.fromJsonString(
	Schema.Struct({
		commit: Schema.String,
		packages: Schema.Tuple([Candidate, Candidate]),
	}),
)
type Candidates = typeof Candidates.Type
const decodeCandidates = Schema.decodeUnknownSync(Candidates)
const PackedManifest = Schema.fromJsonString(
	Schema.Struct({ name: PackageIdentity, version: Schema.String }),
)
const decodePackedManifest = Schema.decodeUnknownSync(PackedManifest)
const decodePackOutput = Schema.decodeUnknownSync(
	Schema.fromJsonString(Schema.Tuple([Schema.Struct({ filename: Schema.String })])),
)

const SourceManifest = Schema.fromJsonString(
	Schema.Struct({ version: Schema.String, exports: Schema.Record(Schema.String, Schema.String) }),
)
const WorkspaceManifest = Schema.fromJsonString(
	Schema.Struct({
		workspaces: Schema.Struct({ catalog: Schema.Struct({ effect: Schema.String }) }),
	}),
)
const manifest = async (path: string) =>
	Schema.decodeSync(SourceManifest)(await readFile(join(repoRoot, path, "package.json"), "utf8"))

const prepare = async (root: string, name: string, source: string) => {
	const directory = join(root, name)
	await rm(directory, { recursive: true, force: true })
	await mkdir(directory, { recursive: true })
	await copyFile(join(repoRoot, "LICENSE"), join(directory, "LICENSE"))
	await copyFile(join(repoRoot, source, "README.md"), join(directory, "README.md"))
	return directory
}

const metadata = (name: string, version: string, directory: string) => ({
	name,
	version,
	license: "Apache-2.0",
	type: "module",
	repository: { type: "git", url: "git+https://github.com/checkfu/checkfu.git", directory },
	bugs: { url: "https://github.com/checkfu/checkfu/issues" },
	engines: { node: ">=22.0.0" },
	publishConfig: { access: "public" },
})

const bundleNotices = async (directory: string, metafile: string) => {
	const metadata = Schema.decodeSync(
		Schema.fromJsonString(Schema.Struct({ inputs: Schema.Record(Schema.String, Schema.Unknown) })),
	)(await readFile(metafile, "utf8"))
	const roots = new Set<string>()
	for (const input of Object.keys(metadata.inputs)) {
		const match = resolve(repoRoot, input)
			.replaceAll("\\", "/")
			.match(/^(.*\/node_modules\/)((?:@[^/]+\/)?[^/]+)/)
		if (match !== null && match[1] !== undefined && match[2] !== undefined) {
			roots.add(match[1] + match[2])
		}
	}
	const notices: Array<string> = []
	for (const root of [...roots].sort()) {
		const dependency = Schema.decodeSync(
			Schema.fromJsonString(Schema.Struct({ name: Schema.String, version: Schema.String })),
		)(await readFile(join(root, "package.json"), "utf8"))
		const candidates = ["LICENSE", "LICENSE.md", "LICENSE.txt", "license", "LICENCE"].map((name) =>
			join(root, name),
		)
		if (dependency.name === "@earendil-works/pi-ai") {
			candidates.push(join(repoRoot, `tools/release/licenses/pi-ai-${dependency.version}.LICENSE`))
		}
		const license = candidates.find(existsSync)
		if (license === undefined) {
			throw new Error(`Missing bundled license for ${dependency.name}@${dependency.version}`)
		}
		notices.push(`${dependency.name}@${dependency.version}\n\n${await readFile(license, "utf8")}`)
	}
	await writeFile(join(directory, "THIRD_PARTY_LICENSES"), notices.join("\n\n---\n\n"))
	await rm(metafile)
}

export const buildCliPackage = async (
	root = releaseRoot,
	commit = currentCommit(),
): Promise<string> => {
	const source = "apps/cli"
	const { version } = await manifest(source)
	const directory = await prepare(root, "checkfu", source)
	const metafile = join(directory, "inputs.json")
	await mkdir(join(directory, "bin"))
	execFileSync(
		"bun",
		[
			"build",
			"--target=node",
			"--packages=bundle",
			"--define",
			"CHECKFU_STANDALONE=true",
			"--define",
			`CHECKFU_DEPLOY_REVISION=${JSON.stringify(commit)}`,
			"--banner",
			"#!/usr/bin/env node",
			join(repoRoot, source, "src/Node.ts"),
			"--outfile",
			join(directory, "bin/checkfu.mjs"),
			`--metafile=${metafile}`,
		],
		{ cwd: repoRoot, stdio: "pipe", timeout: 60_000 },
	)
	await bundleNotices(directory, metafile)
	await chmod(join(directory, "bin/checkfu.mjs"), 0o755)
	await writeFile(
		join(directory, "package.json"),
		JSON.stringify(
			{
				...metadata("checkfu", version, source),
				description:
					"Run Checkfu agents from your terminal and author projects as YAML or Markdown",
				bin: { checkfu: "bin/checkfu.mjs" },
				files: ["bin", "README.md", "LICENSE", "THIRD_PARTY_LICENSES"],
			},
			null,
			2,
		) + "\n",
	)
	return directory
}

export const buildSdkPackage = async (root = releaseRoot): Promise<string> => {
	const source = "packages/sdk"
	const { version, exports: sourceExports } = await manifest(source)
	const workspace = Schema.decodeSync(WorkspaceManifest)(
		await readFile(join(repoRoot, "package.json"), "utf8"),
	)
	const directory = await prepare(root, "sdk", source)
	execFileSync(
		"bun",
		[
			"x",
			"effect-tsgo",
			"tsc",
			"-p",
			join(repoRoot, source, "tsconfig.build.json"),
			"--outDir",
			join(directory, "dist"),
		],
		{ cwd: repoRoot, stdio: "pipe", timeout: 120_000 },
	)
	const exports = Object.fromEntries(
		Object.entries(sourceExports).map(([key, value]) => [
			key,
			{
				types: value.replace("./src/", "./dist/").replace(/\.ts$/, ".d.ts"),
				default: value.replace("./src/", "./dist/").replace(/\.ts$/, ".js"),
			},
		]),
	)
	await writeFile(
		join(directory, "package.json"),
		JSON.stringify(
			{
				...metadata("@checkfu/sdk", version, source),
				description: "Checkfu API client for JavaScript, TypeScript and Effect",
				sideEffects: false,
				main: "./dist/index.js",
				types: "./dist/index.d.ts",
				exports,
				files: ["dist", "README.md", "LICENSE"],
				dependencies: { effect: workspace.workspaces.catalog.effect },
			},
			null,
			2,
		) + "\n",
	)
	return directory
}

const git = (...args: ReadonlyArray<string>): string =>
	execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim()

const currentCommit = () => git("rev-parse", "HEAD")

const pack = (sourceDirectory: string, destination: string): string => {
	const [packed] = decodePackOutput(
		execFileSync(
			"npm",
			[
				"pack",
				sourceDirectory,
				"--ignore-scripts",
				"--workspaces=false",
				"--pack-destination",
				destination,
				"--json",
			],
			{ cwd: repoRoot, encoding: "utf8", timeout: 30_000 },
		),
	)
	return join(destination, packed.filename)
}

export const integrityOf = (contents: Uint8Array | string): string =>
	`sha512-${createHash("sha512").update(contents).digest("base64")}`

const packedPackage = async (file: string, expected?: Candidate) => {
	const bytes = await readFile(file)
	const filename = basename(file)
	const size = bytes.length
	const integrity = integrityOf(bytes)
	if (expected !== undefined && (size !== expected.size || integrity !== expected.integrity)) {
		throw new Error(`Integrity mismatch for ${filename}`)
	}
	const entries = await unpackTar(gunzipSync(bytes))
	const manifests = entries.filter(({ header }) => header.name === "package/package.json")
	const contents = manifests[0]?.data
	if (manifests.length !== 1 || contents === undefined) {
		throw new Error(`Expected one package manifest in ${file}`)
	}
	return {
		bytes,
		metadata: {
			...decodePackedManifest(new TextDecoder().decode(contents)),
			filename,
			size,
			integrity,
		},
	}
}

const checkPackage = async (directory: string, expected: Candidate, name: Candidate["name"]) => {
	const filename = `${name.replace(/^@/u, "").replace("/", "-")}-${expected.version}.tgz`
	if (expected.name !== name || expected.filename !== filename || basename(filename) !== filename) {
		throw new Error(`Expected an unambiguous ${name} tarball`)
	}
	const found = await packedPackage(join(directory, filename), expected)
	const { metadata } = found
	const source = name === "checkfu" ? "apps/cli" : "packages/sdk"
	const { version } = await manifest(source)
	if (
		metadata.name !== name ||
		metadata.version !== expected.version ||
		metadata.version !== version
	) {
		throw new Error(`Package identity mismatch for ${filename}`)
	}
	return found
}

export const qualifiedPackages = async (recordPath: string, recordIntegrity?: string) => {
	const encoded = await readFile(recordPath)
	if (recordIntegrity !== undefined && integrityOf(encoded) !== recordIntegrity) {
		throw new Error("The candidate record changed during qualification.")
	}
	const record = decodeCandidates(encoded.toString("utf8"))
	if (record.commit !== currentCommit()) {
		throw new Error("The candidate source commit differs from this checkout.")
	}
	const directory = dirname(recordPath)
	const cli = await checkPackage(directory, record.packages[0], "checkfu")
	const sdk = await checkPackage(directory, record.packages[1], "@checkfu/sdk")
	return [cli, sdk] as const
}

export const packBuiltPackages = async (
	directories: readonly [string, string],
	destination: string,
	commit = currentCommit(),
) => {
	const [cli, sdk] = await Promise.all([
		packedPackage(pack(directories[0], destination)),
		packedPackage(pack(directories[1], destination)),
	])
	const record: Candidates = { commit, packages: [cli.metadata, sdk.metadata] }
	const recordPath = join(destination, CANDIDATE_RECORD)
	const encoded = JSON.stringify(record, null, 2) + "\n"
	await writeFile(recordPath, encoded, { flag: "wx" })
	return { recordPath, integrity: integrityOf(encoded) }
}

const buildCandidates = async (directory: string, commit: string) => {
	const scratch = await mkdtemp(join(tmpdir(), "checkfu-release-build-"))
	const previous = process.env["CHECKFU_API_KEY"]
	try {
		process.env["CHECKFU_API_KEY"] = BUILD_CREDENTIAL_SENTINEL
		const cli = await buildCliPackage(scratch, commit)
		const sdk = await buildSdkPackage(scratch)
		return await packBuiltPackages([cli, sdk], directory, commit)
	} finally {
		if (previous === undefined) {
			delete process.env["CHECKFU_API_KEY"]
		} else {
			process.env["CHECKFU_API_KEY"] = previous
		}
		await rm(scratch, { recursive: true, force: true })
	}
}

const qualify = async (directory: string) => {
	if (git("status", "--porcelain") !== "") {
		throw new Error("Qualify packages from a clean source commit.")
	}
	const commit = currentCommit()
	await mkdir(directory, { recursive: true })
	if ((await readdir(directory)).length !== 0) {
		throw new Error("Choose an empty candidate directory.")
	}
	const { recordPath, integrity } = await buildCandidates(directory, commit)
	execFileSync("bun", ["run", "--cwd", "tools/release", "test"], {
		cwd: repoRoot,
		env: { ...process.env, [CANDIDATE_ENV]: recordPath, [CANDIDATE_INTEGRITY_ENV]: integrity },
		stdio: "inherit",
		timeout: 6 * 60_000,
	})
	const [cli, sdk] = await qualifiedPackages(recordPath, integrity)
	if (git("status", "--porcelain") !== "") {
		throw new Error("The checkout changed during package qualification.")
	}
	const record: Candidates = { commit, packages: [cli.metadata, sdk.metadata] }
	await writeFile(join(directory, QUALIFIED_RECORD), JSON.stringify(record, null, 2) + "\n", {
		flag: "wx",
	})
}

export const candidateRecordInput = () => {
	const recordPath = process.env[CANDIDATE_ENV]
	const integrity = process.env[CANDIDATE_INTEGRITY_ENV]
	if (recordPath === undefined && integrity === undefined) {
		return undefined
	}
	if (recordPath === undefined || integrity === undefined) {
		throw new Error("Provide the candidate record path and its integrity together.")
	}
	return { recordPath, integrity }
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
	const [command, destination] = process.argv.slice(2)
	if (command === "--qualify" && destination !== undefined) {
		const directory = resolve(destination)
		await qualify(directory)
		process.stdout.write(`Qualified packages recorded in ${join(directory, QUALIFIED_RECORD)}\n`)
	} else if (command === "--verify" && destination !== undefined) {
		const directory = resolve(destination)
		const packages = await qualifiedPackages(join(directory, QUALIFIED_RECORD))
		for (const { metadata } of packages) {
			process.stdout.write(`${join(directory, metadata.filename)} ${metadata.integrity}\n`)
		}
	} else if ((command === undefined || command === "--cli-only") && destination === undefined) {
		await buildCliPackage()
		if (command !== "--cli-only") {
			await buildSdkPackage()
		}
		process.stdout.write(`Release packages prepared in ${releaseRoot}\n`)
	} else {
		throw new Error("Use --qualify <directory>, --verify <directory>, or --cli-only.")
	}
}
