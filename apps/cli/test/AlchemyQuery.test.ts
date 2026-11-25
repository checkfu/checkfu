import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "@effect/vitest"
import * as Schema from "effect/Schema"

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url))
const script = join(repoRoot, "apps", "cli", "scripts", "alchemy-query.ts")
const ACCOUNT = "0123456789abcdef0123456789abcdef"

interface ProcessEnv {
	[name: string]: string
}

const Answer = Schema.fromJsonString(
	Schema.Struct({ status: Schema.String, account_id: Schema.optional(Schema.String) }),
)

const askAccount = (home: string, extra: ProcessEnv): typeof Answer.Type => {
	const env: ProcessEnv = {}
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && !/^(CLOUDFLARE_|ALCHEMY_|CI$)/.test(key)) {
			env[key] = value
		}
	}
	const result = spawnSync("bun", [script, "account", "default", ""], {
		cwd: home,
		env: { ...env, ALCHEMY_HOME: home, ...extra },
		encoding: "utf8",
		timeout: 60_000,
	})
	const line = result.stdout.split("\n").findLast((candidate) => candidate.startsWith("@checkfu "))
	expect(line, result.stderr).toBeDefined()
	return Schema.decodeSync(Answer)((line ?? "").slice("@checkfu ".length))
}

describe("alchemy-query against the installed Alchemy", () => {
	it("reports the account Alchemy would act on, or why it cannot", () => {
		const home = mkdtempSync(join(tmpdir(), "checkfu-alchemy-home-"))
		try {
			expect(askAccount(home, {})).toMatchObject({ status: "not-configured" })
			expect(
				askAccount(home, { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: "token" }),
			).toEqual({ status: "connected", account_id: ACCOUNT })
			expect(
				askAccount(home, {
					CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
					CLOUDFLARE_API_KEY: "key",
					CLOUDFLARE_EMAIL: "ops@example.com",
				}),
			).toEqual({ status: "connected", account_id: ACCOUNT })
			expect(askAccount(home, { CI: "true" })).toMatchObject({ status: "error" })
		} finally {
			rmSync(home, { recursive: true, force: true })
		}
	}, 240_000)
})
