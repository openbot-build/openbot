import config from "../../tsdown.config.ts"
import { defineConfig } from "tsdown"

export default defineConfig({
	...config,
	entry: {
		index: "src/index.ts",
		OpenAiProvider: "src/OpenAiProvider.ts",
		ResponsesCompaction: "src/ResponsesCompaction.ts",
	},
})
