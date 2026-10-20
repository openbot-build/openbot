import config from "../../tsdown.config.ts"
import { defineConfig } from "tsdown"

export default defineConfig({
	...config,
	entry: {
		index: "src/index.ts",
		AnthropicProvider: "src/AnthropicProvider.ts",
	},
})
