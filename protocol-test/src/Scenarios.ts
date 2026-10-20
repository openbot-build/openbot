import { Match, Schema } from "effect"
import { Document } from "@openbot-build/protocol"

export const OAuthMode = Schema.Literals([
	"cimd",
	"dcr",
	"preregistered",
	"client-credentials",
])
export type OAuthMode = typeof OAuthMode.Type
export const Authentication = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("anonymous") }),
	Schema.Struct({
		kind: Schema.Literal("header"),
		name: Schema.String,
		value: Schema.String,
	}),
	Schema.Struct({ kind: Schema.Literal("oauth"), mode: OAuthMode }),
])
export type Authentication = typeof Authentication.Type
export const Scenario = Schema.Struct({
	id: Schema.NonEmptyString,
	title: Schema.NonEmptyString,
	description: Schema.String,
	authentication: Authentication,
})
export type Scenario = typeof Scenario.Type

export const scenarios: ReadonlyArray<Scenario> = [
	{
		id: "anonymous",
		title: "Protocol Test · Anonymous",
		description:
			"Test MCP tools, resources, prompts and Apps without credentials.",
		authentication: { kind: "anonymous" },
	},
	{
		id: "api-key",
		title: "Protocol Test · API Key",
		description: "Test configured secret headers with a public test API key.",
		authentication: {
			kind: "header",
			name: "X-API-Key",
			value: "protocol-test-api-key",
		},
	},
	{
		id: "bearer",
		title: "Protocol Test · Static Bearer",
		description:
			"Test a configured Authorization header with a test Bearer token.",
		authentication: {
			kind: "header",
			name: "Authorization",
			value: "Bearer protocol-test-bearer-token",
		},
	},
	{
		id: "basic",
		title: "Protocol Test · Basic",
		description: "Test configured HTTP Basic credentials for test access.",
		authentication: {
			kind: "header",
			name: "Authorization",
			value: "Basic cHJvdG9jb2wtdGVzdDpwcm90b2NvbC10ZXN0LXBhc3N3b3Jk",
		},
	},
	...OAuthMode.literals.map((mode): Scenario => ({
		id: "oauth-" + mode,
		title: "Protocol Test · OAuth " + mode,
		description: "Test OAuth bound to one resource, using " + mode + ".",
		authentication: { kind: "oauth", mode },
	})),
]

export const scopes = ["test:read", "test:write"]
export const version = "0.1.0"
export const resource = (origin: string) => (scenario: Scenario) =>
	origin + "/mcp/" + scenario.id
export const issuer = (origin: string) => (mode: OAuthMode) =>
	origin + "/oauth/" + mode
export const cardUrl = (origin: string) => (scenario: Scenario) =>
	origin + "/apps/" + scenario.id + "/server-card.json"

export const card =
	(origin: string) =>
	(scenario: Scenario): Document.ServerCard => ({
		$schema: Document.cardSchemaUrl,
		name: "openbot.protocol-test/" + scenario.id,
		title: scenario.title,
		version,
		description: scenario.description,
		websiteUrl: origin + "/apps/" + scenario.id,
		icons: [
			{
				src: origin + "/assets/icon.svg",
				mimeType: "image/svg+xml",
				sizes: ["128x128"],
			},
		],
		remotes: [
			{
				type: "streamable-http",
				url: resource(origin)(scenario),
				supportedProtocolVersions: [Document.protocolVersion],
				...Match.value(scenario.authentication).pipe(
					Match.when({ kind: "header" }, (auth) => ({
						headers: [
							{
								name: auth.name,
								description:
									"Public test credential. See the scenario instructions.",
								isRequired: true,
								isSecret: true,
							},
						],
					})),
					Match.orElse(() => ({})),
				),
			},
			...Match.value(scenario.id).pipe(
				Match.when("api-key", (): ReadonlyArray<Document.Remote> => [
					{
						type: "streamable-http",
						url: "{serviceOrigin}/mcp/api-key",
						supportedProtocolVersions: [Document.protocolVersion],
						variables: {
							serviceOrigin: {
								description: "Published service origin.",
								format: "string",
								default: origin,
								choices: [origin],
								isRequired: true,
							},
						},
						headers: [
							{
								name: "X-API-Key",
								value: "{apiKey}",
								variables: {
									apiKey: {
										description: "Public test key: protocol-test-api-key.",
										format: "string",
										isRequired: true,
										isSecret: true,
									},
								},
							},
						],
					},
				]),
				Match.orElse(() => []),
			),
		],
		_meta: {
			[Document.presentationKey]: {
				version: "1",
				examples: [
					{
						id: "echo",
						title: "Check a connection",
						prompt:
							"Use the Protocol Test App to echo a short message and check the result.",
					},
					{
						id: "workspace",
						title: "Try a temporary workspace",
						prompt:
							"Create a test note in a new Protocol Test workspace. Then show it in the interactive view.",
					},
				],
			},
		},
	})

export const catalog =
	(origin: string) =>
	(selected = scenarios): Document.Catalog => ({
		specVersion: "1.0",
		host: {
			displayName: "OpenBot App Protocol Test Service",
			identifier: origin,
		},
		entries: selected.map((scenario) => ({
			identifier: "openbot.protocol-test/" + scenario.id,
			type: Document.cardMediaType,
			url: cardUrl(origin)(scenario),
			displayName: scenario.title,
			description: scenario.description,
		})),
	})

const HttpsOrigin = Schema.String.check(
	Schema.makeFilter(
		(value) =>
			(URL.canParse(value) &&
				new URL(value).protocol === "https:" &&
				new URL(value).origin === value) ||
			"Expected an exact HTTPS origin with no credentials, path, query or fragment.",
	),
)
export const Settings = Schema.Struct({
	origin: HttpsOrigin,
	allowedOrigins: Schema.Array(HttpsOrigin),
	uiHtml: Schema.NonEmptyString,
	guideMarkdown: Schema.NonEmptyString,
})
export type Settings = typeof Settings.Type
