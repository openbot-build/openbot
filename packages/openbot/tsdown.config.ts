import config from "../../tsdown.config.ts"
import { defineConfig } from "tsdown"

// package.json is the source of `exports` and `bin`, so tsdown must not write
// them. The one key of `exports` is the entry `index`. The four programs
// `Main`, `Migrate`, `Setup` and `Inspect` are the commands in `bin`.
// They start work when they load, so they are entries of the build but not
// keys of `exports`.
export default defineConfig({
	...config,
	entry: {
		index: "src/index.ts",
		Main: "src/Main.ts",
		Migrate: "src/Migrate.ts",
		Setup: "src/Setup.ts",
		Inspect: "src/Inspect.ts",
	},
	exports: false,
})
