import config from "../../tsdown.config.ts"
import { readFileSync } from "node:fs"
import { defineConfig } from "tsdown"

// The keys of `exports` in package.json are the only list of entries. Each
// key is the path of a source module, such as `./settings/Settings`. So
// tsdown must not write `exports`: with one entry it would write the key ".".
const manifest: { readonly exports: Readonly<Record<string, string>> } =
	JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"))

export default defineConfig({
	...config,
	entry: Object.fromEntries(
		Object.keys(manifest.exports).map((key) => [
			key.slice(2),
			`src/${key.slice(2)}.ts`,
		]),
	),
	exports: false,
})
