import { fileURLToPath } from "node:url"
import { defineConfig } from "tsdown"

const path = (relative: string) =>
	fileURLToPath(new URL(relative, import.meta.url))

// Each entry: the output name, its package, and its source in that package.
// tsdown works in the folder of that package, so it reads the package's own
// package.json and tsconfig.json. The Code Mode worker runs in its own thread,
// so it is its own file next to the server. Its source is in the plugin-code
// package.
const entries = [
	["Main", "openbot", "src/Main.ts"],
	["Migrate", "openbot", "src/Migrate.ts"],
	["Setup", "openbot", "src/Setup.ts"],
	["Inspect", "openbot", "src/Inspect.ts"],
	["CodeWorker", "plugin-code", "src/Worker.ts"],
] as const

export default defineConfig(
	entries.map(([name, owner, file]) =>
		defineConfig({
			cwd: path(`../../packages/${owner}`),
			entry: { [name]: file },
			// The server finds the migrations one folder up from this folder, in
			// /app/migrations. Keep the depth.
			outDir: path("../../.devenv/openbot/dist"),
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
