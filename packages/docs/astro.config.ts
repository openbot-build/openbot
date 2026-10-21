import mdx from "@astrojs/mdx"
import starlight from "@astrojs/starlight"
import { defineConfig } from "astro/config"
import autoImport from "astro-auto-import"
import starlightLlmsTxt from "starlight-llms-txt"
import starlightOpenAPI, { openAPISidebarGroups } from "starlight-openapi"

// Docs pages use these components without an import line.
const components = ["Callout", "Card", "Cards", "Step", "Steps", "Tab", "Tabs"]

export default defineConfig({
	// Set DOCS_URL to the public address of the docs site when you deploy it.
	site: process.env["DOCS_URL"] ?? "http://localhost:4321",
	integrations: [
		autoImport({
			imports: components.map((name) => `./src/components/${name}.astro`),
		}),
		starlight({
			title: "OpenBot",
			description: "A headless, API-first Agent platform.",
			social: [
				{
					icon: "github",
					label: "GitHub",
					href: "https://github.com/openbot-build/openbot",
				},
			],
			editLink: {
				baseUrl:
					"https://github.com/openbot-build/openbot/edit/main/packages/docs/",
			},
			plugins: [
				starlightOpenAPI([
					{
						base: "docs/api",
						schema: "./openapi.json",
						sidebar: { label: "API reference" },
					},
				]),
				starlightLlmsTxt({ projectName: "OpenBot" }),
			],
			sidebar: [
				{ label: "Intro", link: "/docs/" },
				{ label: "Quick start", link: "/docs/quickstart/" },
				{
					label: "Usage",
					items: [
						"docs/authentication",
						"docs/sso",
						"docs/organization",
						"docs/permissions",
						"docs/agents",
						"docs/sessions",
						"docs/delegation",
						"docs/requests",
						"docs/rules",
						"docs/memory",
						"docs/apps",
						"docs/app-index",
						"docs/developer-tools",
					],
				},
				{
					label: "Configure",
					items: [
						"docs/configuration",
						"docs/platform",
						"docs/models",
						"docs/error-logs",
						"docs/deploy",
					],
				},
				{
					label: "Develop",
					items: [
						"docs/client",
						"docs/server",
						"docs/packages",
						"docs/protocol",
						"docs/protocol-test",
						"docs/contributing",
					],
				},
				{ label: "Reference", items: openAPISidebarGroups },
			],
		}),
		// Starlight adds MDX on its own, but only after astro-auto-import has
		// looked for it. Then astro-auto-import finds no MDX and does nothing.
		// So we add MDX here, with Starlight's options. It must come after
		// Starlight, because Starlight's code blocks must load before MDX.
		mdx({ optimize: true }),
	],
})
