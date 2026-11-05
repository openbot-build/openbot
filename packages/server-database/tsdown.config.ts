import config from "../../tsdown.config.ts"
import { defineConfig } from "tsdown"

export default defineConfig({
	...config,
	entry: {
		AuthSchema: "src/AuthSchema.ts",
		Database: "src/Database.ts",
		ExecutionSchema: "src/ExecutionSchema.ts",
		"folders/MigrationsFolder": "src/folders/MigrationsFolder.ts",
		PermitSchema: "src/PermitSchema.ts",
		ResourceSchema: "src/ResourceSchema.ts",
		Schema: "src/Schema.ts",
	},
	exports: {
		...config.exports,
		customExports(exports) {
			return Object.fromEntries(
				Object.entries(exports).map(([key, value]) => [
					key === "." ? key : `./${key.split("/").at(-1)}`,
					value,
				]),
			)
		},
	},
})
