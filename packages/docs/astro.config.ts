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
			description: "A headless, API-first Bot platform.",
			// English pages are at the root. Translations are in a folder with the
			// name of the locale. See `src/i18n.ts`.
			defaultLocale: "root",
			locales: docsLocales,
			routeMiddleware: "./src/routeMiddleware.ts",
			components: {
				LanguageSelect: "./src/components/LanguageSelect.astro",
			},
			// Starlight adds its Markdown features, such as the links next to
			// headings, only to pages in `src/content/docs`. Our pages are in
			// `content/docs`, so we name that folder here.
			markdown: { processedDirs: ["./content/docs"] },
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
					label: "Choose a manual",
					translations: {
						"zh-CN": "选择手册",
						de: "Handbuch wählen",
					},
				},
				{
					label: "User manual",
					translations: {
						"zh-CN": "用户手册",
						de: "Benutzerhandbuch",
					},
					collapsed: true,
					items: [
						"docs/users",
						"docs/quickstart",
						"docs/authentication",
						"docs/bots",
						"docs/chats",
						"docs/requests",
						"docs/sharing",
						"docs/files",
						"docs/apps",
						"docs/app-index",
						"docs/channels",
						"docs/live",
						"docs/delegation",
						"docs/triggers",
						"docs/rules",
						"docs/memory",
						"docs/computers",
						"docs/vaults",
						"docs/code-mode",
					],
				},
				{
					label: "Administrator manual",
					translations: {
						"zh-CN": "管理员手册",
						de: "Administrationshandbuch",
					},
					collapsed: true,
					items: [
						"docs/admin",
						{
							label: "Organizations",
							translations: {
								"zh-CN": "组织管理",
								de: "Organisationen",
							},
							collapsed: true,
							items: [
								"docs/organization",
								"docs/permissions",
								"docs/sso",
								"docs/models",
								"docs/usage",
								"docs/admin/channels",
								"docs/admin/computer-providers",
								"docs/admin/secret-providers",
							],
						},
						{
							label: "Platform and servers",
							translations: {
								"zh-CN": "平台与服务器",
								de: "Plattform und Server",
							},
							collapsed: true,
							items: [
								"docs/deploy",
								"docs/configuration",
								"docs/platform",
								"docs/admin/sign-in",
								"docs/admin/file-storage",
								"docs/admin/live-models",
								"docs/admin/code-mode",
								"docs/admin/app-index",
								"docs/admin/pair-computer",
								"docs/error-logs",
							],
						},
					],
				},
				{
					label: "Developer manual",
					translations: {
						"zh-CN": "开发者手册",
						de: "Entwicklerhandbuch",
					},
					collapsed: true,
					items: [
						"docs/developers",
						{
							label: "Clients and API",
							translations: {
								"zh-CN": "客户端与 API",
								de: "Clients und API",
							},
							collapsed: true,
							items: [
								"docs/developers/quickstart",
								"docs/client",
								"docs/developers/authentication",
								"docs/developers/bots",
								"docs/developers/chats",
								"docs/developers/requests",
								"docs/developers/sharing",
								"docs/developers/files",
								"docs/developers/apps",
								"docs/developers/app-index",
								"docs/developers/channels",
								"docs/developers/live",
								"docs/developers/delegation",
								"docs/developers/triggers",
								"docs/developers/rules",
								"docs/developers/memory",
								"docs/developers/computers",
								"docs/developers/vaults",
								"docs/developers/code-mode",
							],
						},
						{
							label: "App publishers",
							translations: {
								"zh-CN": "App 发布者",
								de: "App-Herausgeber",
							},
							collapsed: true,
							items: [
								"docs/protocol",
								"docs/protocol-test",
								"docs/developer-tools",
							],
						},
						{
							label: "Project contributors",
							translations: {
								"zh-CN": "项目贡献者",
								de: "Mitwirkende",
							},
							collapsed: true,
							items: [
								"docs/contributing",
								"docs/developers/testing",
								"docs/packages",
								"docs/architecture",
								"docs/server",
								"docs/developers/model-backends",
								"docs/developers/live-backend",
								"docs/developers/logging",
								"docs/developers/publishing",
							],
						},
						{
							label: "API reference",
							translations: {
								"zh-CN": "API 参考",
								de: "API-Referenz",
							},
							items: openAPISidebarGroups,
						},
					],
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
