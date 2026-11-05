import config from "../../tsdown.config.ts"
import { readFileSync } from "node:fs"
import { defineConfig } from "tsdown"

// The keys of `exports` in package.json are the list of entries, with one more:
// the Code Mode worker. The key "." is the plugin in `src/index.ts`. Each other
// key is the name of a source module, such as `./Sandbox`. So tsdown must not
// write `exports`.
const manifest: { readonly exports: Readonly<Record<string, string>> } =
	JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"))

export default defineConfig({
	...config,
	entry: {
		...Object.fromEntries(
			Object.keys(manifest.exports).map((key) => {
				const name = key === "." ? "index" : key.slice(2)
				return [name, `src/${name}.ts`]
			}),
		),
		// The worker runs in its own thread. Nothing imports it, and it starts
		// work when it loads, so it is an entry of the build but not a key of
		// `exports`. `Sandbox.ts` finds `Worker.js` next to itself.
		Worker: "src/Worker.ts",
	},
	exports: false,
})
