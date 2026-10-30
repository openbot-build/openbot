import { fileURLToPath } from "node:url"
import { defineConfig } from "tsdown"

const path = (relative: string) =>
	fileURLToPath(new URL(relative, import.meta.url))

// The Code Mode worker runs in its own thread, so it is its own file next to the server.
const entries = [
	["Main", "src/app/Main.ts"],
	["Migrate", "src/app/Migrate.ts"],
	["Setup", "src/app/Setup.ts"],
	["Inspect", "src/app/Inspect.ts"],
	["CodeWorker", "src/code/Worker.ts"],
] as const

export default defineConfig(
	entries.map(([name, file]) =>
		defineConfig({
			cwd: path("../../packages/openbot"),
			entry: { [name]: file },
			outDir: path("../../.devenv/openbot/dist/app"),
			clean: false,
			format: "esm",
			fixedExtension: true,
			platform: "node",
			target: "node26",
			dts: false,
			sourcemap: false,
			deps: { alwaysBundle: [/.*/] },
			outputOptions: { codeSplitting: false },
		}),
	),
)
