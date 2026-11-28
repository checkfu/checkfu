import { expect, it } from "vitest"
import { matrix } from "./Verification.ts"
import type { Evidence, Source } from "./Verification.ts"

const source: Source = { commit: "candidate", fingerprint: "all-source-bytes", dirty: false }
const execution = (
	options: { file?: string; status?: string; success?: boolean; duplicate?: boolean } = {},
): Evidence => ({
	group: "mcp",
	source,
	finishedSource: source,
	startedAt: "2026-11-27T00:00:00Z",
	finishedAt: "2026-11-27T00:00:01Z",
	node: "v24",
	platform: "linux/x64",
	command: ["vitest"],
	exitCode: 0,
	runner: {
		success: options.success ?? true,
		testResults: [
			{
				name: options.file ?? "/checkout/apps/mcp/test/Mcp.interoperability.test.ts",
				assertionResults: [
					{
						title: "retry",
						fullName: "independent retry",
						status: options.status ?? "passed",
						tags: ["acceptance", "mcp-uncertain-create"],
						failureMessages: [],
						meta: {},
					},
				],
			},
		].flatMap((file) => (options.duplicate === true ? [file, file] : [file])),
	},
})
const retry = (runs: ReadonlyArray<Evidence>) =>
	matrix(source, runs).cases.find((row) => row.id === "mcp-uncertain-create")

it("requires one actual passing case from the registered file and the exact tested source", () => {
	expect(retry([execution()])?.status).toBe("passed")
	expect(retry([])?.status).toBe("unverified")
	expect(retry([execution(), execution()])?.status).toBe("unverified")
	for (const change of [{ commit: "older" }, { fingerprint: "different bytes" }, { dirty: true }]) {
		expect(retry([{ ...execution(), source: { ...source, ...change } }])?.status).toBe("unverified")
		expect(retry([{ ...execution(), finishedSource: { ...source, ...change } }])?.status).toBe(
			"unverified",
		)
	}
	expect(retry([execution({ file: "/checkout/unrelated.test.ts" })])?.status).toBe("unverified")
})

it("never promotes skipped, absent, duplicated or interrupted runner results to a pass", () => {
	for (const status of ["skipped", "pending", "todo", "disabled"]) {
		expect(retry([execution({ status })])?.status).toBe("unverified")
	}
	expect(retry([{ ...execution(), runner: null }])?.status).toBe("unverified")
	expect(retry([{ ...execution(), exitCode: 1 }])?.status).toBe("unverified")
	expect(retry([execution({ status: "failed", success: false })])?.status).toBe("failed")
	expect(retry([execution({ duplicate: true })])?.status).toBe("unverified")
})

it("keeps untouched surfaces, actual browser behavior and unsupported promises outside passing evidence", () => {
	const report = matrix(source, [execution()])
	const cell = report.cells.find((row) => row.promise.includes("lost committed"))
	expect(cell?.surfaces["mcp"]).toMatchObject({ status: "passed" })
	expect(cell?.surfaces["ui"]).toMatchObject({ status: "unverified" })
	expect(report.gaps.map((gap) => gap.id)).toContain("mcp-oauth-refresh")
	expect(report.cases.find((row) => row.id === "deployment-source")?.status).toBe("unverified")
	expect(report.blockers.map((blocker) => blocker.id)).toContain("deployment-source")
	expect(report.releaseQualified).toBe(false)
})

it("credits the project interfaces only for the actions each performs", () => {
	const template = execution().runner?.testResults[0]?.assertionResults[0]
	expect(template).toBeDefined()
	const evidence: Evidence = {
		...execution(),
		group: "project",
		runner: {
			success: true,
			testResults: [
				{
					name: "/checkout/apps/api/test/workerd/PiSession.workerd.ts",
					assertionResults: [
						{
							...template!,
							tags: ["acceptance", "authored-project-cli", "authored-project-mcp"],
						},
					],
				},
			],
		},
	}
	const report = matrix(source, [evidence])
	expect(report.cases.filter(({ group }) => group === "project")).toMatchObject([
		{ id: "authored-project-cli", surfaces: ["yaml", "cli"], status: "passed" },
		{ id: "authored-project-mcp", surfaces: ["mcp"], status: "passed" },
	])
	expect(
		report.cells.find(({ promise }) => promise.includes("prune"))?.surfaces["mcp"],
	).toMatchObject({ status: "unverified" })
	expect(
		report.cells.find(({ promise }) => promise.includes("Read automation pins"))?.surfaces["mcp"],
	).toMatchObject({ status: "passed", cases: ["authored-project-mcp"] })
	const failedProducer = matrix(source, [{ ...evidence, exitCode: 1 }])
	expect(
		failedProducer.cases.filter(({ group }) => group === "project").map(({ status }) => status),
	).toEqual(["unverified", "unverified"])
})

it("ignores untagged assertions in a full run but still requires the runner to succeed", () => {
	const run = execution()
	const file = run.runner!.testResults[0]!
	const full: Evidence = {
		...run,
		runner: {
			success: true,
			testResults: [
				{
					...file,
					assertionResults: [
						...file.assertionResults,
						{
							...file.assertionResults[0]!,
							title: "unrelated passing case",
							fullName: "unrelated passing case",
							tags: [],
						},
					],
				},
			],
		},
	}
	expect(retry([full])).toMatchObject({ status: "passed", evidence: [expect.anything()] })
	expect(
		retry([{ ...full, runner: { ...full.runner!, success: false }, exitCode: 1 }])?.status,
	).toBe("unverified")
})
