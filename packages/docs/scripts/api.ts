// Writes the OpenAPI document from the Platform API contract and the API reference pages built from it.
import { mkdir, rm, writeFile } from "node:fs/promises"
import { PlatformApi } from "@openbot-build/platform-api"
import { OpenApi } from "effect/http-api"
import { generateFiles } from "fumadocs-openapi"
import { createOpenAPI } from "fumadocs-openapi/server"

const output = "content/docs/api"
// Page file names and titles for each API group, in reading order.
const groups = [
	["account", "Account"],
	["login", "Sign-in"],
	["apiKeys", "API keys"],
	["sessions", "Sessions"],
	["approvals", "Approvals"],
	["apps", "App discovery"],
	["connections", "Connections"],
	["appAuthorization", "App authorization"],
	["appAuthorizationPublic", "App authorization callbacks"],
	["appOperations", "App operations"],
	["appViews", "App views"],
	["appExperience", "App transfer and reset"],
	["appIndex", "App Index"],
	["developer", "Developer tools"],
	["developerPublic", "Public developer tools"],
	["health", "Service and health"],
] as const

await writeFile(
	"openapi.json",
	JSON.stringify(OpenApi.fromApi(PlatformApi), null, 2) + "\n",
)
await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })
await generateFiles({
	input: createOpenAPI({ input: ["./openapi.json"] }),
	output: "./" + output,
	per: "tag",
	includeDescription: true,
	beforeWrite(files) {
		for (const file of files) {
			const name = file.path
				.split("/")
				.at(-1)
				?.replace(/\.mdx$/, "")
			const group = groups.find(([tag]) => tag.toLowerCase() === name)
			if (group === undefined) continue
			file.path = file.path.replace(/[^/]+\.mdx$/, group[0] + ".mdx")
			file.content = file.content.replace(/^title: .*$/m, "title: " + group[1])
		}
	},
})
await writeFile(
	output + "/index.mdx",
	`---
title: API reference
description: Every Platform HTTP operation, made from the API contract.
---

This reference is made from the same contract that the server and the TypeScript client use, so it always matches the running Platform.
You can also read the raw document at \`/openapi.json\` on any Platform, or open \`/docs\` on a Platform for an interactive view.

Most operations need an API key in the \`Authorization: Bearer <key>\` header. See [Authentication](/docs/authentication).
`,
)
await writeFile(
	output + "/meta.json",
	JSON.stringify(
		{ title: "API reference", pages: ["index", ...groups.map(([tag]) => tag)] },
		null,
		2,
	) + "\n",
)
