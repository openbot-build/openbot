import { docsSchema } from "@astrojs/starlight/schema"
import { defineCollection } from "astro:content"
import { glob } from "astro/loaders"

// Page paths follow their files: `index.mdx` is `/`, `deploy.mdx` is
// `/deploy/`, and `de/deploy.mdx` is `/de/deploy/`.
export const collections = {
	docs: defineCollection({
		loader: glob({
			base: "./content/docs",
			pattern: "**/[^_]*.{md,mdx}",
		}),
		schema: docsSchema(),
	}),
}
