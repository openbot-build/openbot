import { docsSchema } from "@astrojs/starlight/schema"
import { defineCollection } from "astro:content"
import { glob } from "astro/loaders"

import { docsLocales } from "./i18n.ts"

// The pages live in `content/docs`, and every page URL has `/docs/` in it.
// `index.mdx` becomes `/docs/` and `deploy.mdx` becomes `/docs/deploy/`.
// A translation lives in the folder of its language, so `de/deploy.mdx`
// becomes `/de/docs/deploy/`.
const translated = Object.keys(docsLocales).filter((key) => key !== "root")

const pageId = (entry: string): string => {
	const path = entry.replace(/\.mdx?$/, "")
	const [first, ...rest] = path.split("/")
	const id =
		first !== undefined && translated.includes(first)
			? `${first}/docs/${rest.join("/")}`
			: `docs/${path}`
	return id.replace(/\/index$/, "")
}

export const collections = {
	docs: defineCollection({
		loader: glob({
			base: "./content/docs",
			pattern: "**/[^_]*.{md,mdx}",
			generateId: ({ entry }) => pageId(entry),
		}),
		schema: docsSchema(),
	}),
}
