import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		projects: [
			"packages/{api,cli,client,computer,core,domain,e2e,identity-contract,openbot,protocol,server-billing,server-database,server-execution,server-kernel,server-plugin}",
			"protocol-test",
		],
	},
})
