import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { parse } from "@cloudflare/forge"
import { generateApplySchemas } from "./ApplySchemas.ts"
import { generateCliFiles } from "./CliTransformer.ts"
import { generateMcpFiles } from "./McpTransformer.ts"
import { exportDeterministicOpenApiJson } from "./OpenApiExport.ts"
import { generateSdkFiles } from "./SdkTransformer.ts"

const THIS_DIR = import.meta.dirname
export const REPO_ROOT = resolve(THIS_DIR, "../../..")

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
		...generateApplySchemas(),
		...cliFiles.map((file) => ({
			relativePath: `apps/cli/src/generated/${file.path}`,
			content: file.content,
		})),
		...sdkFiles.map((file) => ({
			relativePath: `packages/sdk/src/generated/${file.path}`,
			content: file.content,
		})),
		...mcpFiles.map((file) => ({
			relativePath: `apps/mcp/src/generated/${file.path}`,
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
	const formatted = formatArtifacts(generateAllArtifacts(), repoRoot)

	if (!check) {
		for (const artifact of formatted) {
			const target = join(repoRoot, artifact.relativePath)
			mkdirSync(dirname(target), { recursive: true })
			writeFileSync(target, artifact.content, "utf8")
			process.stdout.write(`forge: wrote ${artifact.relativePath}\n`)
		}
		return { ok: true, drifted: [] }
	}

	const drifted: Array<string> = []
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
