import { describe, expect, it } from "@effect/vitest"
import * as Schema from "effect/Schema"
import { CredentialDeleted, VaultDeleted } from "../src/Api.ts"

const custody = { storing: 0, held: 0, erasing: 1 }

describe("Public delete result schemas", () => {
	it("accept both the confirmed and the still-erasing answer their types admit", () => {
		const vaults: ReadonlyArray<VaultDeleted> = [
			{ id: "vlt_1", type: "vault_deleted", secrets: "erased", custody },
			{ id: "vlt_1", type: "vault_deleted", secrets: "erasing", custody },
		]
		const credentials: ReadonlyArray<CredentialDeleted> = [
			{ id: "vcrd_1", type: "vault_credential_deleted", custody: "erased" },
			{ id: "vcrd_1", type: "vault_credential_deleted", custody: "erasing" },
		]
		expect(vaults.map((value) => Schema.decodeSync(VaultDeleted)(value))).toEqual(vaults)
		expect(credentials.map((value) => Schema.decodeSync(CredentialDeleted)(value))).toEqual(
			credentials,
		)
	})
})
