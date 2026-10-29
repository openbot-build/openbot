// Writes the OpenAPI document from the OpenBot API contract.
// The starlight-openapi plugin makes the API reference pages from this file.
import { writeFile } from "node:fs/promises"
import { OpenBotApi } from "@openbot-build/api"
import { OpenApi } from "effect/http-api"

// The title and a short description for each API group, in reading order.
// The sidebar uses this order. A group with a description gets its own page.
const groups = [
	[
		"emailSignIn",
		"Email sign-in",
		"Sign in with a single-use email code when the platform enables it.",
	],
	[
		"access",
		"Account access",
		"Manage first access, registration requests, accounts and platform audit events.",
	],
	[
		"loginOptions",
		"Login options",
		"Read public sign-in options without private settings.",
	],
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
		"Add providers with API keys or ChatGPT sign-in, and list the models you can use.",
	],
	["sso", "SSO", "Verify email domains and add SSO connections."],
	[
		"usage",
		"Usage",
		"Read the model usage, its cost, and the credits of the organization.",
	],
	[
		"budgets",
		"Budgets",
		"Set spending limits for the organization, members, Bots, and user tokens.",
	],
	[
		"platform",
		"Platform",
		"Manage the whole platform. Only platform admins can use it.",
	],
	[
		"bots",
		"Bots",
		"Make, manage, and share Bots, with their memory, Rules, Grants, members, and invitations.",
	],
	[
		"chats",
		"Chats",
		"Talk to a Bot. Each Bot has one Chat with each person, and the Bot always answers at once.",
	],
	[
		"executions",
		"Executions",
		"Read saved execution events, send a cancel command, and answer a decision.",
	],
	[
		"live",
		"Live",
		"Talk with a Bot in real time, with sound, over one WebSocket.",
	],
	[
		"files",
		"Files",
		"Upload files, such as pictures and PDFs, and give them to a Bot in a message.",
	],
	[
		"delegations",
		"Delegations",
		"Read or stop the work that a Bot gave to another Bot or to itself.",
	],
	[
		"botInvitations",
		"Bot invitations",
		"Accept an invitation to use a Bot in your own organization.",
	],
	[
		"triggers",
		"Triggers",
		"Give a task to a Bot with a prompt, on a schedule or from a webhook.",
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
		"computerProviders",
		"Computer providers",
		"Add your accounts at services that run Computers, such as E2B and Daytona.",
	],
	[
		"computers",
		"Computers",
		"Make and use machines where Bots run commands, change files and use a desktop.",
	],
	[
		"computerHooks",
		"Computer connectors",
		"Pair your own machine and keep it connected. The token is the only credential.",
	],
	[
		"secretProviders",
		"Secret providers",
		"Add your accounts at password managers and secrets services, such as 1Password, Bitwarden and HashiCorp Vault.",
	],
	[
		"vaults",
		"Vaults",
		"Collect secrets from many providers, and let Bots use them in Code Mode without seeing them.",
	],
	[
		"memberSettings",
		"Your settings",
		"Read and change your own settings, such as how your plans are approved.",
	],
	[
		"requests",
		"Requests",
		"Answer the requests of your Bots for new capabilities.",
	],
	["apps", "App discovery", "Find Apps that the Bot can use."],
	["connections", "Connections", "Connect an account to an App."],
	["appAuthorization", "App authorization", "Let an App act for you."],
	[
		"appAuthorizationPublic",
		"App authorization callbacks",
		"Pages that an App sends you back to after authorization.",
	],
	[
		"toolCalls",
		"Tool calls",
		"Read the tool calls of a Chat and their saved results.",
	],
	[
		"appOperations",
		"App operations",
		"Run App operations and read their results.",
	],
	[
		"codeRuns",
		"Code runs",
		"Read the Code Mode programs of a Chat and their App calls.",
	],
	["appViews", "App views", "Read the views that Apps show."],
	[
		"appExperience",
		"App transfer and reset",
		"Export, import, and reset what the Bot learned about Apps.",
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

This reference is made from the same contract that the server and the TypeScript client use, so it always matches the running OpenBot. [Download the OpenAPI document](/openapi.json) to use it with your own tools, such as a code generator. Every OpenBot also serves it at \`/openapi.json\`. See [Authentication](/authentication) and [Permissions](/permissions).`,
	},
	tags: groups.map(([, name, description]) => ({ name, description })),
}

await writeFile("openapi.json", JSON.stringify(output, null, 2) + "\n")
