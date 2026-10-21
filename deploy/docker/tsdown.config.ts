import { fileURLToPath } from "node:url"
import { defineConfig } from "tsdown"

const path = (relative: string) =>
	fileURLToPath(new URL(relative, import.meta.url))

export default defineConfig(
	["Main", "Migrate"].map((name) =>
		defineConfig({
			cwd: path("../../packages/platform"),
			entry: { [name]: `src/app/${name}.ts` },
			outDir: path("../../.devenv/platform/dist/app"),
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
