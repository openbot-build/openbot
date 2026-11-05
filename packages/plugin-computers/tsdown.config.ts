import config from "../../tsdown.config.ts"
import { readFileSync } from "node:fs"
import { defineConfig } from "tsdown"

// The keys of `exports` in package.json are the only list of entries. The key
// "." is the plugin in `src/index.ts`. Each other key is the name of a source
// module, such as `./Setup`. So tsdown must not write `exports`.
const manifest: { readonly exports: Readonly<Record<string, string>> } =
	JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"))

export default defineConfig({
	...config,
	entry: Object.fromEntries(
		Object.keys(manifest.exports).map((key) => {
			const name = key === "." ? "index" : key.slice(2)
			return [name, `src/${name}.ts`]
		}),
	),
	exports: false,
})
