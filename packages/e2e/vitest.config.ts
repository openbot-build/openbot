import { availableParallelism } from "node:os"
import { defineProject } from "vitest/config"

export default defineProject({
	test: {
		name: "e2e",
		include: ["test/**/*.test.ts"],
		setupFiles: ["test/Environment.ts"],
		// Each file has its own test process and services. Limit the active files.
		maxWorkers: Math.min(4, availableParallelism()),
		// The root run needs a separate group when process limits differ.
		sequence: { groupOrder: 1 },
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
})
