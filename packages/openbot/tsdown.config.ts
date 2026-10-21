import config from "../../tsdown.config.ts"
import { defineConfig } from "tsdown"

export default defineConfig({
	...config,
	entry: {
		index: "src/index.ts",
		"database/Migrations": "src/database/Migrations.ts",
		"sessions/RepositoryPostgres": "src/sessions/RepositoryPostgres.ts",
		Main: "src/app/Main.ts",
		Development: "src/app/Development.ts",
		DevelopmentMain: "src/app/DevelopmentMain.ts",
		Migrate: "src/app/Migrate.ts",
	},
	exports: {
		...config.exports,
		exclude: ["Main", "Migrate", "Development", "DevelopmentMain"],
		customExports(exports) {
			return Object.fromEntries(
				Object.entries(exports).map(([key, value]) => {
					const name = key.split("/").at(-1)
					return [
						key === "."
							? key
							: `./${name === "Migrations" ? "StorageMigration" : name}`,
						value,
					]
				}),
			)
		},
		bin: {
			openbot: "./src/app/Main.ts",
			"openbot-migrate": "./src/app/Migrate.ts",
		},
	},
})
