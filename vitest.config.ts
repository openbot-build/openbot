import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		projects: [
			"packages/{api,cli,client,computer,core,domain,e2e,openbot,protocol}",
			"protocol-test",
		],
	},
})
