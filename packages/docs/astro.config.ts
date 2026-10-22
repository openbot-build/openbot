import mdx from "@astrojs/mdx"
import starlight from "@astrojs/starlight"
import { defineConfig } from "astro/config"
import autoImport from "astro-auto-import"
import starlightLlmsTxt from "starlight-llms-txt"
import starlightOpenAPI, { openAPISidebarGroups } from "starlight-openapi"
import { docsLocales } from "./src/i18n.ts"

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
			// English pages are at the root. Translations are in a folder with the
			// name of the locale. See `src/i18n.ts`.
			defaultLocale: "root",
			locales: docsLocales,
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
				{
					slug: "docs",
					label: "Intro",
					translations: { "zh-CN": "简介", de: "Einführung" },
				},
				{
					slug: "docs/quickstart",
					label: "Quick start",
					translations: { "zh-CN": "快速开始", de: "Schnellstart" },
				},
				{
					label: "Usage",
					translations: { "zh-CN": "使用", de: "Nutzung" },
					items: [
						"docs/authentication",
						"docs/sso",
						"docs/organization",
						"docs/permissions",
						"docs/agents",
						"docs/sessions",
						"docs/delegation",
						"docs/triggers",
						"docs/channels",
						"docs/requests",
						"docs/rules",
						"docs/memory",
						"docs/apps",
						"docs/code-mode",
						"docs/app-index",
						"docs/developer-tools",
					],
				},
				{
					label: "Configure",
					translations: { "zh-CN": "配置", de: "Konfiguration" },
					items: [
						"docs/configuration",
						"docs/platform",
						"docs/models",
						"docs/usage",
						"docs/error-logs",
						"docs/deploy",
					],
				},
				{
					label: "Develop",
					translations: { "zh-CN": "开发", de: "Entwicklung" },
					items: [
						"docs/client",
						"docs/server",
						"docs/packages",
						"docs/protocol",
						"docs/protocol-test",
						"docs/contributing",
					],
				},
				{
					label: "Reference",
					translations: { "zh-CN": "参考", de: "Referenz" },
					items: openAPISidebarGroups,
				},
			],
		}),
		// Starlight adds MDX on its own, but only after astro-auto-import has
		// looked for it. Then astro-auto-import finds no MDX and does nothing.
		// So we add MDX here, with Starlight's options. It must come after
		// Starlight, because Starlight's code blocks must load before MDX.
		mdx({ optimize: true }),
	],
})
