// Writes the OpenAPI document from the OpenBot API contract.
// The starlight-openapi plugin makes the API reference pages from this file.
import { writeFile } from "node:fs/promises"
import { OpenBotApi } from "@openbot-build/api"
import { OpenApi } from "effect/http-api"

// The title and a short description for each API group, in reading order.
// The sidebar uses this order. A group with a description gets its own page.
const groups = [
	["account", "Account", "Read the signed-in user and their organizations."],
	["signIn", "Sign-in", "Start a browser sign-in."],
	[
		"organizations",
		"Organizations",
		"List your organizations and make a new one.",
	],
	["userTokens", "User tokens", "Make, list, check, and revoke user tokens."],
	[
		"organization",
		"Organization",
		"Manage settings, members, roles, policies, and the audit log.",
	],
	[
		"modelProviders",
		"Model providers",
		"Add model providers with your own keys, and list the models you can use.",
	],
	["sso", "SSO", "Verify email domains and add SSO connections."],
	[
		"platform",
		"Platform",
		"Manage the whole platform. Only platform admins can use it.",
	],
	[
		"agents",
		"Agents",
		"Make and manage Agents, their memory, Rules, and Grants.",
	],
	["sessions", "Sessions", "Give work to an Agent in Sessions and Turns."],
	[
		"triggers",
		"Triggers",
		"Start a Session for an Agent with a prompt, on a schedule or from a webhook.",
	],
	[
		"triggerHooks",
		"Trigger webhooks",
		"Fire a trigger from another system with its webhook secret.",
	],
	[
		"channels",
		"Channels",
		"Manage the bots of the organization in Slack, Lark, Telegram and other chat systems.",
	],
	[
		"channelLinks",
		"Channel links",
		"Link your own accounts on the platforms of Channels.",
	],
	[
		"channelHooks",
		"Channel webhooks",
		"Take the events of chat platforms. The signature of the platform is the only credential.",
	],
	[
		"memberSettings",
		"Your settings",
		"Read and change your own settings, such as how your plans are approved.",
	],
	[
		"requests",
		"Requests",
		"Answer the requests of your Agents for new capabilities.",
	],
	["apps", "App discovery", "Find Apps that the Agent can use."],
	["connections", "Connections", "Connect an account to an App."],
	["appAuthorization", "App authorization", "Let an App act for you."],
	[
		"appAuthorizationPublic",
		"App authorization callbacks",
		"Pages that an App sends you back to after authorization.",
	],
	[
		"appOperations",
		"App operations",
		"Run App operations and read their results.",
	],
	["appViews", "App views", "Read the views that Apps show."],
	[
		"appExperience",
		"App transfer and reset",
		"Export, import, and reset what the Agent learned about Apps.",
	],
	["appIndex", "App Index", "Search the public index of Apps."],
	["developer", "Developer tools", "Test and watch the Apps that you publish."],
	[
		"developerPublic",
		"Public developer tools",
		"Developer tools that work without sign-in.",
	],
	[
		"health",
		"Service and health",
		"Read the service document and check health.",
	],
] as const

const titles = new Map<string, string>(
	groups.map(([tag, title]) => [tag, title] as const),
)
const document = OpenApi.fromApi(OpenBotApi)

const missing = (document.tags ?? [])
	.map((tag) => tag.name)
	.filter((name) => !titles.has(name))
if (missing.length > 0) {
	throw new Error(
		`Add a title for these API groups in scripts/api.ts: ${missing.join(", ")}`,
	)
}

const title = (name: string) => titles.get(name) ?? name

for (const pathItem of Object.values(document.paths)) {
	for (const operation of Object.values(pathItem ?? {})) {
		if (
			typeof operation === "object" &&
			operation !== null &&
			"tags" in operation &&
			operation.tags !== undefined
		) {
			const [first, ...rest] = operation.tags
			operation.tags = [title(first), ...rest.map(title)]
		}
	}
}

const output = {
	...document,
	info: {
		...document.info,
		description: `${document.info.description ?? ""}

This reference is made from the same contract that the server and the TypeScript client use, so it always matches the running OpenBot. [Download the OpenAPI document](/openapi.json) to use it with your own tools, such as a code generator. Every OpenBot also serves it at \`/openapi.json\`. See [Authentication](/docs/authentication) and [Permissions](/docs/permissions).`,
	},
	tags: groups.map(([, name, description]) => ({ name, description })),
}

await writeFile("openapi.json", JSON.stringify(output, null, 2) + "\n")
