import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		projects: [
			"packages/{api,apps-contract,cli,client,computer,conversation-contract,core,domain,e2e,identity-contract,model-providers,models-contract,openbot,plugin-access,plugin-audit,plugin-auth,plugin-authorization,plugin-billing,plugin-code,plugin-files,plugin-mail,plugin-models,plugin-organization,plugin-platform,plugin-settings,plugin-sso,plugin-vaults,protocol,server-billing,server-database,server-execution,server-kernel,server-plugin,tools-contract}",
			"protocol-test",
		],
	},
})
