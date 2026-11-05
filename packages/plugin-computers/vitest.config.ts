import { defineProject } from "vitest/config"

export default defineProject({
	test: {
		include: ["test/**/*.test.ts"],
		// The entries test loads the whole built plugin. When all packages run
		// their tests at the same time, this can take more than five seconds.
		testTimeout: 30_000,
	},
})
