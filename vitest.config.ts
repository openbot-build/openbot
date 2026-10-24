import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		projects: [
			"packages/{ability,cli,computer,core,openbot,protocol}",
			"protocol-test",
		],
	},
})
