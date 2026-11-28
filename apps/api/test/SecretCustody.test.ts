import { describe, expect, it } from "@effect/vitest"
import { makeSecretCustody } from "../src/Connection/SecretCustody.ts"
import { makeCustodyDatabase } from "./helpers/CustodyDatabase.ts"

const TARGET = "https://docs.mcp.example/mcp"
const secret = (token: string) => ({ type: "static_bearer" as const, token })

const vault = () => {
	const database = makeCustodyDatabase()
	return { ...database, custody: makeSecretCustody(database.sql) }
}

describe("Sealing a vault's secrets", () => {
	it("removes every secret and keeps the seal, however many credentials the vault ever held", async () => {
		const { custody, rows } = vault()
		for (let index = 0; index < 500; index += 1) {
			custody.put(`vcrd_${index}`, secret(`token-number-${index}`), TARGET, "create")
			if (index % 2 === 0) {
				custody.erase(`vcrd_${index}`)
			}
		}
		custody.seal()
		expect(rows()).toEqual({ secrets: [], tombstones: [], sealed: true })
		expect(custody.read("vcrd_1")).toBeNull()
		expect(custody.put("vcrd_1", secret("token-again"), TARGET, "replace")).toEqual({
			refused: "erased",
		})
	})

	it("stopped partway, changes nothing; sealing again finishes", async () => {
		const { custody, rows, failAt } = vault()
		custody.put("vcrd_a", secret("token-a-secret"), TARGET, "create")
		failAt("INSERT INTO vault")
		expect(() => custody.seal()).toThrow("stopped at")
		expect(rows()).toEqual({ secrets: ["vcrd_a"], tombstones: [], sealed: false })
		custody.seal()
		expect(rows()).toEqual({ secrets: [], tombstones: [], sealed: true })
		expect(custody.read("vcrd_a")).toBeNull()
	})

	it("refuses a create that arrives after the seal", async () => {
		const { custody, rows } = vault()
		custody.seal()
		expect(custody.put("vcrd_late", secret("token-late"), TARGET, "create")).toEqual({
			refused: "erased",
		})
		expect(rows()).toEqual({ secrets: [], tombstones: [], sealed: true })
	})
})

describe("Erasing one credential's secret", () => {
	it("removes the secret and records the erasure together, even in a sealed vault", async () => {
		const { custody, rows } = vault()
		custody.put("vcrd_a", secret("token-a-secret"), TARGET, "create")
		custody.put("vcrd_b", secret("token-b-secret"), TARGET, "create")
		custody.erase("vcrd_a")
		expect(rows()).toEqual({ secrets: ["vcrd_b"], tombstones: ["vcrd_a"], sealed: false })
		custody.seal()
		custody.erase("vcrd_b")
		expect(rows()).toEqual({ secrets: [], tombstones: ["vcrd_b"], sealed: true })
	})

	it("stopped partway, changes nothing; erasing again finishes", async () => {
		const { custody, rows, failAt } = vault()
		custody.put("vcrd_a", secret("token-a-secret"), TARGET, "create")
		failAt("INSERT OR IGNORE INTO tombstones")
		expect(() => custody.erase("vcrd_a")).toThrow("stopped at")
		expect(rows()).toEqual({ secrets: ["vcrd_a"], tombstones: [], sealed: false })
		custody.erase("vcrd_a")
		expect(rows()).toEqual({ secrets: [], tombstones: ["vcrd_a"], sealed: false })
	})

	it("refuses a create or a replace that arrives after the erasure", async () => {
		const { custody, rows } = vault()
		custody.erase("vcrd_a")
		expect(custody.put("vcrd_a", secret("token-a-secret"), TARGET, "create")).toEqual({
			refused: "erased",
		})
		expect(custody.put("vcrd_a", secret("token-a-secret"), TARGET, "replace")).toEqual({
			refused: "erased",
		})
		expect(rows()).toEqual({ secrets: [], tombstones: ["vcrd_a"], sealed: false })
	})
})

describe("Creating a credential's secret", () => {
	it("keeps the secret it holds, so a repeated create never overwrites a rotation", () => {
		const { custody, stored } = vault()
		expect(custody.put("vcrd_a", secret("token-a-secret"), TARGET, "create")).toEqual({
			refused: null,
		})
		expect(custody.put("vcrd_a", secret("token-rotated"), TARGET, "replace")).toEqual({
			refused: null,
		})
		expect(custody.put("vcrd_a", secret("token-a-secret"), TARGET, "create")).toEqual({
			refused: null,
		})
		expect(custody.read("vcrd_a")?.secret.token).toBe("token-rotated")
		expect(stored()).not.toContain("token-a-secret")
	})
})
