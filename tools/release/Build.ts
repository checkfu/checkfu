import * as Schema from "effect/Schema"
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const repoRoot = fileURLToPath(new URL("../../", import.meta.url))
export const releaseRoot = join(repoRoot, "dist", "npm")

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
	engines: { node: ">=22" },
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
		if (dependency.name === "@earendil-works/pi-ai" && dependency.version === "1.6.0") {
			candidates.push(join(repoRoot, "tools/release/licenses/pi-ai-1.6.0.LICENSE"))
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

export const buildCliPackage = async (root = releaseRoot): Promise<string> => {
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

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
	await buildCliPackage()
	if (!process.argv.includes("--cli-only")) {
		await buildSdkPackage()
	}
	process.stdout.write(`Release packages prepared in ${releaseRoot}\n`)
}
