import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		projects: [
			"packages/{api,apps-contract,cli,client,computer,conversation-contract,core,domain,e2e,identity-contract,model-providers,models-contract,openbot,plugin-access,plugin-apps,plugin-artifacts,plugin-audit,plugin-auth,plugin-authorization,plugin-billing,plugin-bots,plugin-capabilities,plugin-channels,plugin-chats,plugin-code,plugin-computers,plugin-files,plugin-mail,plugin-models,plugin-organization,plugin-platform,plugin-settings,plugin-sso,plugin-time-limiter,plugin-token-limiter,plugin-triggers,plugin-turn-limiter,plugin-vaults,plugin-work,protocol,server-billing,server-database,server-development,server-execution,server-kernel,server-plugin,server-testing,tools-contract}",
			"protocol-test",
		],
	},
})
