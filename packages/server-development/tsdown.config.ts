import config from "../../tsdown.config.ts"
import { readFileSync } from "node:fs"
import { defineConfig } from "tsdown"

// The keys of `exports` in package.json are the list of entries, with one more:
// the program `DevelopmentMain`. It runs the server when it loads, so it is an
// entry of the build but not a key of `exports`. Each key is the name of a
// source module, such as `./Development`. So tsdown must not write `exports`.
const manifest: { readonly exports: Readonly<Record<string, string>> } =
	JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"))

export default defineConfig({
	...config,
	entry: {
		...Object.fromEntries(
			Object.keys(manifest.exports).map((key) => [
				key.slice(2),
				`src/${key.slice(2)}.ts`,
			]),
		),
		DevelopmentMain: "src/DevelopmentMain.ts",
	},
	exports: false,
})
