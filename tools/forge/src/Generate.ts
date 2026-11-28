import { spawnSync } from "node:child_process"
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { dirname, join, posix, relative, resolve } from "node:path"
import { parse } from "@cloudflare/forge"
import { generateApplySchemas } from "./ApplySchemas.ts"
import { generateCliFiles } from "./CliTransformer.ts"
import { generateMcpFiles } from "./McpTransformer.ts"
import { exportDeterministicOpenApiJson } from "./OpenApiExport.ts"
import { generateSdkFiles } from "./SdkTransformer.ts"

const THIS_DIR = import.meta.dirname
export const REPO_ROOT = resolve(THIS_DIR, "../../..")

const generatedDirectories = {
	cli: "apps/cli/src/generated",
	sdk: "packages/sdk/src/generated",
	mcp: "apps/mcp/src/generated",
}

export interface EmittedArtifact {
	readonly relativePath: string
	readonly content: string
}

export const generateAllArtifacts = (): ReadonlyArray<EmittedArtifact> => {
	const openApiJson = exportDeterministicOpenApiJson()
	const forge = parse(openApiJson)
	const cliFiles = generateCliFiles(forge)
	const sdkFiles = generateSdkFiles(forge)
	const mcpFiles = generateMcpFiles(forge, openApiJson)

	return [
		{
			relativePath: "openapi.json",
			content: openApiJson,
		},
		{
			relativePath: "apps/api/public/openapi.json",
			content: openApiJson,
		},
		{
			relativePath: "apps/docs/openapi.json",
			content: openApiJson,
		},
		...generateApplySchemas(),
		...cliFiles.map((file) => ({
			relativePath: `${generatedDirectories.cli}/${file.path}`,
			content: file.content,
		})),
		...sdkFiles.map((file) => ({
			relativePath: `${generatedDirectories.sdk}/${file.path}`,
			content: file.content,
		})),
		...mcpFiles.map((file) => ({
			relativePath: `${generatedDirectories.mcp}/${file.path}`,
			content: file.content,
		})),
	]
}

const formatArtifacts = (
	artifacts: ReadonlyArray<EmittedArtifact>,
	repoRoot: string,
): ReadonlyArray<EmittedArtifact> => {
	const scratch = mkdtempSync(join(repoRoot, ".forge-gen-"))
	try {
		const scratchPaths: Array<string> = []
		for (const artifact of artifacts) {
			const dest = join(scratch, artifact.relativePath)
			mkdirSync(dirname(dest), { recursive: true })
			writeFileSync(dest, artifact.content, "utf8")
			scratchPaths.push(dest)
		}
		const oxfmtBin = join(repoRoot, "node_modules", ".bin", "oxfmt")
		const result = spawnSync(oxfmtBin, scratchPaths, {
			cwd: repoRoot,
			encoding: "utf8",
		})
		if (result.status !== 0) {
			throw new Error(`oxfmt failed on generated files:\n${result.stderr || result.stdout}`)
		}
		return artifacts.map((artifact) => ({
			relativePath: artifact.relativePath,
			content: readFileSync(join(scratch, artifact.relativePath), "utf8"),
		}))
	} finally {
		rmSync(scratch, { recursive: true, force: true })
	}
}

const checkOutputPaths = (repoRoot: string, artifacts: ReadonlyArray<EmittedArtifact>): void => {
	const directories = new Set([
		...Object.values(generatedDirectories),
		...artifacts.map(({ relativePath }) => posix.dirname(relativePath)),
	])
	for (const directory of directories) {
		let parent = repoRoot
		for (const part of directory.split("/")) {
			parent = join(parent, part)
			const info = lstatSync(parent, { throwIfNoEntry: false })
			if (info === undefined) {
				break
			}
			if (!info.isDirectory()) {
				throw new Error(`Expected a directory within the checkout at ${relative(repoRoot, parent)}`)
			}
		}
	}
	for (const { relativePath } of artifacts) {
		const info = lstatSync(join(repoRoot, relativePath), { throwIfNoEntry: false })
		if (info !== undefined && (!info.isFile() || info.nlink > 1)) {
			throw new Error(`Expected a regular generated file at ${relativePath}`)
		}
	}
}

const staleArtifacts = (repoRoot: string, artifacts: ReadonlyArray<EmittedArtifact>) => {
	const emitted = new Set(artifacts.map((artifact) => join(repoRoot, artifact.relativePath)))
	const stale: Array<string> = []
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name)
			if (entry.isDirectory()) {
				visit(path)
			} else if (!emitted.has(path)) {
				stale.push(relative(repoRoot, path))
			}
		}
	}
	for (const directory of Object.values(generatedDirectories)) {
		const root = join(repoRoot, directory)
		if (lstatSync(root, { throwIfNoEntry: false }) !== undefined) {
			visit(root)
		}
	}
	return stale.sort()
}

export interface GenerateResult {
	readonly ok: boolean
	readonly drifted: ReadonlyArray<string>
}

export const runGenerate = (options?: {
	readonly check?: boolean
	readonly repoRoot?: string
}): GenerateResult => {
	const repoRoot = options?.repoRoot ?? REPO_ROOT
	const check = options?.check ?? false
	const artifacts = generateAllArtifacts()
	checkOutputPaths(repoRoot, artifacts)
	const formatted = formatArtifacts(artifacts, repoRoot)
	const stale = staleArtifacts(repoRoot, formatted)

	if (!check) {
		for (const path of stale) {
			rmSync(join(repoRoot, path))
			process.stdout.write(`forge: removed ${path}\n`)
		}
		for (const artifact of formatted) {
			const target = join(repoRoot, artifact.relativePath)
			mkdirSync(dirname(target), { recursive: true })
			writeFileSync(target, artifact.content, "utf8")
			process.stdout.write(`forge: wrote ${artifact.relativePath}\n`)
		}
		return { ok: true, drifted: [] }
	}

	const drifted = stale.slice()
	for (const path of stale) {
		process.stderr.write(`forge drift: ${path} is no longer generated\n`)
	}
	for (const artifact of formatted) {
		const target = join(repoRoot, artifact.relativePath)
		let existing: string | undefined
		try {
			existing = readFileSync(target, "utf8")
		} catch {
			drifted.push(artifact.relativePath)
			process.stderr.write(`forge drift: missing ${relative(repoRoot, target)}\n`)
			continue
		}
		if (existing !== artifact.content) {
			drifted.push(artifact.relativePath)
			process.stderr.write(
				`forge drift: ${relative(repoRoot, target)} differs from CheckfuApi contract\n`,
			)
		}
	}

	if (drifted.length > 0) {
		process.stderr.write("\nRun `bun run generate` and commit the updated generated files.\n")
		return { ok: false, drifted }
	}

	process.stdout.write(
		`forge: ${formatted.length} generated artifact(s) match CheckfuApi contract\n`,
	)
	return { ok: true, drifted: [] }
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename

if (isMain) {
	const check = process.argv.includes("--check")
	const result = runGenerate({ check })
	if (!result.ok) {
		process.exit(1)
	}
}
