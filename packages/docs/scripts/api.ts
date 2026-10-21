// Writes the OpenAPI document from the Platform API contract.
// The starlight-openapi plugin makes the API reference pages from this file.
import { writeFile } from "node:fs/promises"
import { PlatformApi } from "@openbot-build/platform-api"
import { OpenApi } from "effect/http-api"

// The title and a short description for each API group, in reading order.
// The sidebar uses this order. A group with a description gets its own page.
const groups = [
	["account", "Account", "Read the signed-in user."],
	["userTokens", "User tokens", "Make, list, check, and revoke user tokens."],
	[
		"organization",
		"Organization",
		"Manage members, roles, policies, and the audit log.",
	],
	[
		"agents",
		"Agents",
		"Make and manage Agents, their memory, Rules, and Grants.",
	],
	["sessions", "Sessions", "Give work to an Agent in Sessions and Turns."],
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
const document = OpenApi.fromApi(PlatformApi)

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

This reference is made from the same contract that the server and the TypeScript client use, so it always matches the running Platform. [Download the OpenAPI document](/openapi.json) to use it with your own tools, such as a code generator. Every Platform also serves it at \`/openapi.json\`. See [Authentication](/docs/authentication) and [Permissions](/docs/permissions).`,
	},
	tags: groups.map(([, name, description]) => ({ name, description })),
}

await writeFile("openapi.json", JSON.stringify(output, null, 2) + "\n")
