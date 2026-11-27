import { verificationTags } from "../../../../tools/release/Verification.ts"
import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		tags: verificationTags,
		include: ["test/workerd/**/*.workerd.ts"],
		pool: "threads",
		fileParallelism: false,
	},
})
