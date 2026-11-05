import { fileURLToPath } from "node:url"
import { defineConfig } from "drizzle-kit"

// drizzle-kit reads these paths from the folder where it runs, not from the
// folder of this file. Paths from this file let the command run in any folder.
const here = (relative: string) =>
	fileURLToPath(new URL(relative, import.meta.url))

export default defineConfig({
	dialect: "postgresql",
	schema: [here("./src/Schema.ts"), here("./src/AuthSchema.ts")],
	out: here("./migrations"),
})
