import { defineProject } from "vitest/config"

export default defineProject({
	test: {
		name: "e2e",
		include: ["test/**/*.test.ts"],
		setupFiles: ["test/Environment.ts"],
		// Each user task starts real services. Run files in order to bound their load.
		fileParallelism: false,
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
})
