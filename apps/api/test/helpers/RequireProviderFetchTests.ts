import type { Reporter, TestModule } from "vitest/node"

export default class RequireProviderFetchTests implements Reporter {
	onTestRunEnd(modules: ReadonlyArray<TestModule>): void {
		if (!("Bun" in globalThis)) {
			throw new Error("The provider fetch test lane requires Bun.")
		}
		const passed = modules.flatMap((module) => Array.from(module.children.allTests("passed")))
		if (passed.length !== 2) {
			throw new Error(
				`Expected two passing provider fetch tests under Bun, found ${passed.length}.`,
			)
		}
	}
}
