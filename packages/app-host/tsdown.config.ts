import { defineConfig } from "tsdown"
import config from "../../tsdown.config.ts"

export default defineConfig({
	...config,
	entry: {
		main: "src/main.ts",
		App: "src/App.ts",
		Index: "src/Index.ts",
	},
	exports: {
		...config.exports,
		customExports(exports) {
			const { "./main": main, ...rest } = exports
			return { ".": main, ...rest }
		},
	},
})
