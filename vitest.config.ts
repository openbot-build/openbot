import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		projects: [
			"packages/{cli,computer,core,openbot,protocol}",
			"protocol-test",
		],
	},
})
