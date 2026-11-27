import { describe, expect, it } from "@effect/vitest"
import * as Result from "effect/Result"
import fc from "fast-check"
import {
	bindMcpServers,
	decodeMcpServerCredentials,
	encodeMcpServerCredentials,
	mcpHostAllowed,
	resolveMcpServerCredentials,
} from "../src/Mcp/McpServers.ts"
import type { CredentialRequest } from "../src/Mcp/McpServers.ts"

const url = (n: number) => `https://s${n}.mcp.example/mcp`

const request: fc.Arbitrary<CredentialRequest> = fc
	.record({
		servers: fc.uniqueArray(fc.integer({ min: 0, max: 5 }), { maxLength: 5 }),
		vaults: fc.array(fc.uniqueArray(fc.integer({ min: 0, max: 7 }), { maxLength: 4 }), {
			maxLength: 4,
		}),
		named: fc.array(fc.integer({ min: 0, max: 3 }), { maxLength: 8 }),
		explicit: fc.array(
			fc.record({
				server: fc.integer({ min: 0, max: 6 }),
				credential: fc.integer({ min: 0, max: 40 }),
				target: fc.option(fc.integer({ min: 0, max: 6 })),
			}),
			{ maxLength: 3 },
		),
	})
	.map(({ servers, vaults, named, explicit }) => ({
		servers: servers.map((n) => ({ type: "url" as const, name: `s${n}`, url: url(n) })),
		explicit: explicit.map((pair) => ({
			mcp_server_name: `s${pair.server}`,
			credential_id: `cred_x${pair.credential}`,
			vault_id: pair.target === null ? null : `vlt_x${pair.credential}`,
			target: pair.target === null ? null : url(pair.target),
		})),
		vaults: named
			.filter((index) => index < vaults.length)
			.map((index) => ({
				id: `vlt_${index}`,
				credentials: (vaults[index] ?? []).map((n) => ({
					credential_id: `cred_${index}_${n}`,
					mcp_server_url: url(n),
				})),
			})),
	}))

const matchesIn = (input: CredentialRequest, server: string) => {
	const declared = input.servers.find((candidate) => candidate.name === server)
	return new Set(
		input.vaults.flatMap((vault) =>
			vault.credentials
				.filter((credential) => credential.mcp_server_url === declared?.url)
				.map((credential) => credential.credential_id),
		),
	)
}

describe("The credential each MCP server gets", () => {
	it("is at most one per declared server, the named one first, else the only match", () => {
		fc.assert(
			fc.property(request, (input) => {
				const resolved = resolveMcpServerCredentials(input)
				if (Result.isFailure(resolved)) {
					return
				}
				const pairs = resolved.success
				expect(new Set(pairs.map((pair) => pair.mcp_server_name)).size).toBe(pairs.length)
				for (const server of input.servers) {
					const given = pairs.find((pair) => pair.mcp_server_name === server.name)
					const named = input.explicit.find((pair) => pair.mcp_server_name === server.name)
					const matches = matchesIn(input, server.name)
					if (named !== undefined) {
						expect(given?.credential_id).toBe(named.credential_id)
						expect(given?.vault_id).toBe(named.vault_id)
						expect(named.target).toBe(server.url)
					} else if (matches.size === 0) {
						expect(given).toBeUndefined()
					} else {
						expect([...matches]).toEqual([given?.credential_id])
						expect(
							input.vaults
								.find((vault) => vault.id === given?.vault_id)
								?.credentials.map((credential) => credential.credential_id),
						).toContain(given?.credential_id)
					}
				}
				expect(
					pairs.every((pair) => input.servers.some((s) => s.name === pair.mcp_server_name)),
				).toBe(true)
			}),
			{ numRuns: 2000 },
		)
	})

	it("refuses rather than chooses: a name given twice or unknown, a credential for another server, several matches", () => {
		fc.assert(
			fc.property(request, (input) => {
				const names = input.explicit.map((pair) => pair.mcp_server_name)
				const duplicate = new Set(names).size !== names.length
				const unknown = names.some((name) => !input.servers.some((s) => s.name === name))
				const mistargeted = input.explicit.some(
					(pair) => input.servers.find((s) => s.name === pair.mcp_server_name)?.url !== pair.target,
				)
				const ambiguous = input.servers.filter(
					(server) => !names.includes(server.name) && matchesIn(input, server.name).size > 1,
				)
				const resolved = resolveMcpServerCredentials(input)
				expect(Result.isFailure(resolved)).toBe(
					duplicate || unknown || mistargeted || ambiguous.length > 0,
				)
				if (Result.isFailure(resolved) && !duplicate && !unknown && !mistargeted) {
					expect(resolved.failure.kind).toBe("ambiguous_credentials")
					expect(
						ambiguous.some((server) => resolved.failure.message.includes(`"${server.name}"`)),
					).toBe(true)
				}
			}),
			{ numRuns: 2000 },
		)
	})

	it("does not depend on how often or in what order the vaults are named", () => {
		fc.assert(
			fc.property(request, fc.infiniteStream(fc.nat()), (input, order) => {
				const shuffled = [...input.vaults, ...input.vaults]
					.map((vault) => ({ vault, at: order.next().value }))
					.toSorted((a, b) => a.at - b.at)
					.map(({ vault }) => vault)
				const once = [...new Map(input.vaults.map((vault) => [vault.id, vault])).values()]
				const outcome = (vaults: CredentialRequest["vaults"]) => {
					const resolved = resolveMcpServerCredentials({ ...input, vaults })
					return Result.isFailure(resolved) ? "refused" : resolved.success
				}
				expect(outcome(shuffled)).toEqual(outcome(once))
				expect(outcome(input.vaults)).toEqual(outcome(once))
			}),
			{ numRuns: 1000 },
		)
	})

	it("survives the text a session carries it in, and binds only the servers it names", () => {
		fc.assert(
			fc.property(request, (input) => {
				const resolved = resolveMcpServerCredentials(input)
				if (Result.isFailure(resolved)) {
					return
				}
				const text = encodeMcpServerCredentials(resolved.success)
				expect(text).toBeDefined()
				expect(decodeMcpServerCredentials(text)).toEqual(resolved.success)
				const bound = bindMcpServers(input.servers, decodeMcpServerCredentials(text))
				expect(bound.map((binding) => [binding.name, binding.url])).toEqual(
					input.servers.map((server) => [server.name, server.url]),
				)
				expect(bound.filter((binding) => binding.credential_id !== null)).toHaveLength(
					resolved.success.length,
				)
			}),
			{ numRuns: 500 },
		)
		expect(decodeMcpServerCredentials("not json")).toEqual([])
		expect(decodeMcpServerCredentials(undefined)).toEqual([])
		expect(
			encodeMcpServerCredentials(
				Array.from({ length: 21 }, (_, i) => ({ mcp_server_name: `s${i}`, credential_id: "c" })),
			),
		).toBeUndefined()
	})

	it("lets a host through only when the environment's rules do", () => {
		const limited = (allow_mcp_servers: boolean, allowed_hosts: ReadonlyArray<string>) => ({
			type: "limited" as const,
			allow_mcp_servers,
			allow_package_managers: false,
			allowed_hosts,
		})
		expect(mcpHostAllowed(null, "docs.example.test")).toBe(true)
		expect(mcpHostAllowed(undefined, "docs.example.test")).toBe(true)
		expect(mcpHostAllowed({ type: "unrestricted" }, "docs.example.test")).toBe(true)
		expect(mcpHostAllowed(limited(true, []), "docs.example.test")).toBe(true)
		expect(mcpHostAllowed(limited(false, []), "docs.example.test")).toBe(false)
		for (const [configured, requested, allowed] of [
			["docs.example.test", "docs.example.test", true],
			["Docs.Example.Test", "docs.example.test", true],
			["docs.example.test", "DOCS.EXAMPLE.TEST", true],
			["Docs.Example.Test", "other.example.test", false],
			["docs.example.test", "docs.example.test:8443", false],
			["Docs.Example.Test:8443", "docs.example.test:8443", true],
			["docs.example.test:8443", "docs.example.test:9443", false],
		] as const) {
			expect(mcpHostAllowed(limited(false, [configured]), requested)).toBe(allowed)
		}
	})
})
