import { execFile } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { promisify } from "node:util"
import { gzipSync } from "node:zlib"
import { packTar } from "modern-tar"
import { expect, it } from "vitest"
import { makeGithubDistribution } from "../../apps/cli/src/Deployment/Distribution.ts"
import {
	installDependencies,
	managedEnvironment,
	prepareManaged,
} from "../../apps/cli/src/Deployment/Managed.ts"
import { repoRoot } from "./Build.ts"

const execute = promisify(execFile)

it.skipIf(process.platform === "win32")(
	"installs the real deployment runtime and frozen server outside the checkout, then enforces the shipped baseline without system Bun or Git",
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "checkfu-real-deployment-"))
		try {
			// Only version-controlled files; never the developer's .env, auth, node_modules, or caches.
			const { stdout } = await execute("git", ["ls-files", "-z"], {
				cwd: repoRoot,
				maxBuffer: 1024 * 1024,
			})
			const entries = []
			for (const name of stdout.split("\0").filter(Boolean)) {
				const body = new Uint8Array(await readFile(join(repoRoot, name)))
				entries.push({
					header: { name: `checkfu/${name}`, type: "file" as const, size: body.length },
					body,
				})
			}
			const archive = gzipSync(await packTar(entries))
			const path = join(directory, "path")
			const home = join(directory, "home")
			await mkdir(path)
			await mkdir(home)
			await symlink(process.execPath, join(path, "node"))
			// Dependency install and all subsequent commands see no system Bun, Git, Docker or npm.
			const env = managedEnvironment({
				PATH: path,
				HOME: home,
				CI: "1",
				CHECKFU_MANAGED_DEPLOYMENT: "1",
			})
			const installed = await prepareManaged(
				directory,
				{ operation: "deploy", stage: "staging" },
				{
					distribution: {
						...makeGithubDistribution("a".repeat(40)),
						source: async () => archive,
					},
					target: `${process.platform}-${process.arch}`,
					env,
					install: installDependencies,
					announce: () => {},
				},
				new AbortController().signal,
			)
			expect(installed.root.startsWith(repoRoot)).toBe(false)
			const runtime = await execute(installed.runtime, ["--version"], {
				env,
				cwd: home,
				timeout: 10_000,
			})
			expect(runtime.stdout.trim()).toBe(
				JSON.parse(await readFile(join(repoRoot, "checkfu.deployment.json"), "utf8")).runtime
					.version,
			)
			await execute("bun", ["--no-env-file", "run", "--cwd", "apps/app", "build"], {
				cwd: installed.root,
				env: installed.environment,
				timeout: 60_000,
				maxBuffer: 4 * 1024 * 1024,
			})
			const check = () =>
				execute(installed.runtime, ["--no-env-file", "apps/api/test/persisted/main.ts", "check"], {
					cwd: installed.root,
					env,
					timeout: 30_000,
					maxBuffer: 1024 * 1024,
				})
			await check()
			const baseline = join(installed.root, "apps/api/test/persisted/Persisted.lock.json")
			await writeFile(baseline, `${await readFile(baseline, "utf8")}\n`)
			await expect(check()).rejects.toMatchObject({
				code: 1,
				stderr: expect.stringContaining("uncommitted changes"),
			})
			// An update repairs the immutable source cache while retaining the user's deployment directory.
			await installed.record()
			await writeFile(join(installed.dataRoot, ".env"), "CHECKFU_API_KEY=stable", { mode: 0o600 })
			expect(await readFile(join(installed.root, ".checkfu/source.json"), "utf8")).toContain(
				"baseline_sha256",
			)
			expect(dirname(installed.runtime)).not.toBe(path)
		} finally {
			await rm(directory, { recursive: true, force: true })
		}
	},
	180_000,
)
