import { defineConfig } from "tsdown"
import config from "../../tsdown.config.ts"

export default defineConfig({
	...config,
	entry: { Main: "src/Main.ts" },
	dts: false,
	exports: false,
})
