import { defineConfig } from "drizzle-kit"
export default defineConfig({
	dialect: "postgresql",
	schema: [
		"./packages/openbot/src/database/Schema.ts",
		"./packages/openbot/src/database/AuthSchema.ts",
	],
	out: "./packages/openbot/migrations",
})
