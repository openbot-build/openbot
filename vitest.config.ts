import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		projects: [
			"packages/{api,cli,computer,core,openbot,protocol}",
			"protocol-test",
		],
	},
})
