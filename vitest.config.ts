import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		projects: [
			"packages/{api,apps-contract,cli,client,computer,conversation-contract,core,domain,e2e,identity-contract,model-providers,models-contract,openbot,protocol,server-billing,server-database,server-execution,server-kernel,server-plugin,tools-contract}",
			"protocol-test",
		],
	},
})
