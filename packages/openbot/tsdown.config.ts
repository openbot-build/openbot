import config from "../../tsdown.config.ts"
import { defineConfig } from "tsdown"

export default defineConfig({
	...config,
	entry: {
		index: "src/index.ts",
		"database/Migrations": "src/database/Migrations.ts",
		Main: "src/app/Main.ts",
		Development: "src/app/Development.ts",
		DevelopmentMain: "src/app/DevelopmentMain.ts",
		Migrate: "src/app/Migrate.ts",
		Setup: "src/app/Setup.ts",
		// The Code Mode worker. Nothing imports it, so it needs its own entry.
		"code/Worker": "src/code/Worker.ts",
	},
	exports: {
		...config.exports,
		exclude: ["Main", "Migrate", "Setup", "DevelopmentMain", "code/Worker"],
		customExports(exports) {
			return {
				...Object.fromEntries(
					Object.entries(exports).map(([key, value]) => {
						const name = key.split("/").at(-1)
						return [
							key === "."
								? key
								: `./${name === "Migrations" ? "StorageMigration" : name}`,
							value,
						]
					}),
				),
				// Keep the test source export when the build writes the package exports.
				"./testing": "./test/Testing.ts",
			}
		},
		bin: {
			"openbot-server": "./src/app/Main.ts",
			"openbot-migrate": "./src/app/Migrate.ts",
			"openbot-setup": "./src/app/Setup.ts",
		},
	},
})
