import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		include: ["test/workerd/**/*.workerd.ts"],
		pool: "threads",
		fileParallelism: false,
	},
})
