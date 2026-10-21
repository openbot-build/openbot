import { docsSchema } from "@astrojs/starlight/schema"
import { defineCollection } from "astro:content"
import { glob } from "astro/loaders"

// The pages live in `content/docs`, and every page URL starts with `/docs/`.
// `index.mdx` becomes `/docs/` and `deploy.mdx` becomes `/docs/deploy/`.
export const collections = {
	docs: defineCollection({
		loader: glob({
			base: "./content/docs",
			pattern: "**/[^_]*.{md,mdx}",
			generateId: ({ entry }) =>
				`docs/${entry.replace(/\.mdx?$/, "")}`.replace(/\/index$/, ""),
		}),
		schema: docsSchema(),
	}),
}
