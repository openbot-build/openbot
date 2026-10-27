import { defineProject } from "vitest/config"

export default defineProject({
	test: {
		include: ["test/**/*.test.ts"],
		setupFiles: ["test/Environment.ts"],
		// Some tests wait for real servers and timers for many seconds.
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
})
