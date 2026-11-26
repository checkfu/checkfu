import { MAX_ARTIFACT_NAME_LENGTH } from "@checkfu/domain/Artifact/ArtifactTypes"
import { describe, expect, it } from "@effect/vitest"
import { outputsArtifactName } from "../src/OutputsIdentity.ts"
import { SESSION_OUTPUTS_PATH, makeSessionOutputs } from "../src/Workspace/SessionOutputs.ts"

const workspace = () => {
	const reads: Array<string> = []
	const outputs = makeSessionOutputs({
		list: () => Promise.resolve([]),
		size: () => Promise.resolve(0),
		read: (file) => {
			reads.push(file)
			return Promise.resolve(new TextEncoder().encode(file))
		},
	})
	return { reads, outputs }
}

describe("A session's outputs reader", () => {
	it("reads a path inside the outputs directory", async () => {
		const { reads, outputs } = workspace()
		await outputs.read(["report.md", "data/totals.csv"])
		expect(reads).toEqual([
			`${SESSION_OUTPUTS_PATH}/report.md`,
			`${SESSION_OUTPUTS_PATH}/data/totals.csv`,
		])
	})

	it.each(["../../../workspace/notes.md", "data/../../secret", "/etc/passwd", "./a.txt", ""])(
		"refuses %j without reading anything",
		async (path) => {
			const { reads, outputs } = workspace()
			await expect(outputs.read(["report.md", path])).rejects.toThrow(
				"is not a path in the outputs directory",
			)
			expect(reads).toEqual([])
		},
	)
})

describe("A session's outputs artifact name", () => {
	it("keeps the fallback within the artifact name limit for the longest session id", () => {
		const name = outputsArtifactName("s".repeat(256), null)
		expect(Array.from(name)).toHaveLength(MAX_ARTIFACT_NAME_LENGTH)
		expect(name.startsWith("Session s")).toBe(true)
	})
})
