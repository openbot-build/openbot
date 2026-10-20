import config from "../../tsdown.config.ts"
import { defineConfig } from "tsdown"

export default defineConfig({
	...config,
	entry: {
		"network/HttpNetwork": "src/network/HttpNetwork.ts",
		"node/Node": "src/node/Node.ts",
		"discovery/Robots": "src/discovery/Robots.ts",
		"discovery/RobotsPolicy": "src/discovery/RobotsPolicy.ts",
		"apps/McpApps": "src/apps/McpApps.ts",
		"apps/AppUi": "src/apps/AppUi.ts",
		"publication/McpPublisher": "src/publication/McpPublisher.ts",
		"publication/PublisherProtection": "src/publication/PublisherProtection.ts",
		"connections/AppConnections": "src/connections/AppConnections.ts",
		"connections/McpClient": "src/connections/McpClient.ts",
		"connections/OAuthAuthorization": "src/connections/OAuthAuthorization.ts",
		"connections/MemoryStore": "src/connections/MemoryStore.ts",
		"indexing/MemoryIndex": "src/indexing/MemoryIndex.ts",
		"indexing/PublicIndexing": "src/indexing/PublicIndexing.ts",
		"discovery/CatalogDiscovery": "src/discovery/CatalogDiscovery.ts",
		"indexing/Index": "src/indexing/Index.ts",
		"indexing/Indexing": "src/indexing/Indexing.ts",
		"apps/Apps": "src/apps/Apps.ts",
		"apps/Ui": "src/apps/Ui.ts",
		"discovery/Discovery": "src/discovery/Discovery.ts",
		"node/NodeHttpServer": "src/node/NodeHttpServer.ts",
		"network/Network": "src/network/Network.ts",
		"publication/Publisher": "src/publication/Publisher.ts",
		main: "src/main.ts",
		Document: "src/Document.ts",
		"connections/Store": "src/connections/Store.ts",
		"connections/App": "src/connections/App.ts",
		"connections/Client": "src/connections/Client.ts",
		"connections/Authorization": "src/connections/Authorization.ts",
		"publication/Protection": "src/publication/Protection.ts",
	},
	exports: {
		...config.exports,
		customExports(exports) {
			const { "./main": main, ...rest } = exports
			return {
				".": main,
				...Object.fromEntries(
					Object.entries(rest).map(([key, value]) => [
						`./${key.split("/").at(-1)}`,
						value,
					]),
				),
			}
		},
	},
})
