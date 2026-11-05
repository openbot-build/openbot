import config from "../../tsdown.config.ts"
import { defineConfig } from "tsdown"

// package.json is the source of `exports` and `bin`, so tsdown must not write
// them. The keys of `exports` are the entries `index` and `Parts`. The four
// programs `Main`, `Migrate`, `Setup` and `Inspect` are the commands in `bin`.
// They start work when they load, so they are entries of the build but not
// keys of `exports`.
export default defineConfig({
	...config,
	entry: {
		index: "src/index.ts",
		Parts: "src/app/Parts.ts",
		Main: "src/app/Main.ts",
		Migrate: "src/app/Migrate.ts",
		Setup: "src/app/Setup.ts",
		Inspect: "src/app/Inspect.ts",
	},
	exports: false,
})
