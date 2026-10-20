import { defineConfig } from "drizzle-kit"
export default defineConfig({
	dialect: "postgresql",
	schema: [
		"./packages/platform/src/database/Schema.ts",
		"./packages/platform/src/database/AuthSchema.ts",
	],
	out: "./packages/platform/migrations",
})
