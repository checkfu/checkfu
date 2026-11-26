import { configDefaults, defineConfig } from "vitest/config"

const prove = process.env.CHECKFU_PROVE === "1"

if (!prove && process.env.GITHUB_ACTIONS === "true") {
	throw new Error("CI must run the Z3 proofs: set CHECKFU_PROVE=1 on the domain job")
}

export default defineConfig({
	test: {
		exclude: prove
			? configDefaults.exclude
			: [...configDefaults.exclude, "test/**/*.verify.test.ts"],
	},
})
