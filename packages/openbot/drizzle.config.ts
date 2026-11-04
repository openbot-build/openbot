import { defineConfig } from "drizzle-kit"
export default defineConfig({
	dialect: "postgresql",
	schema: [
		"./packages/openbot/src/server-database/Schema.ts",
		"./packages/openbot/src/server-database/AuthSchema.ts",
	],
	out: "./packages/openbot/migrations",
})
