import config from "../../tsdown.config.ts"
import { readFileSync } from "node:fs"
import { defineConfig } from "tsdown"

// The keys of `exports` in package.json are the only list of entries. Each
// key is the path of a source module, such as `./Store`, and `.` is
// `src/index.ts`. A key that does not point into `dist` is not built.
const manifest: { readonly exports: Readonly<Record<string, string>> } =
	JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"))

export default defineConfig({
	...config,
	entry: Object.fromEntries(
		Object.entries(manifest.exports)
			.filter(([, target]) => target.startsWith("./dist/"))
			.map(([key]) =>
				key === "."
					? ["index", "src/index.ts"]
					: [key.slice(2), `src/${key.slice(2)}.ts`],
			),
	),
	exports: false,
})
