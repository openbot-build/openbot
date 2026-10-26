import {
	Array as Arr,
	Duration,
	Effect,
	Layer,
	pipe,
	String as Str,
} from "effect"
import {
	HttpRouter,
	HttpServerResponse,
	type HttpServerRequest,
} from "effect/http"
import { Document } from "@openbot-build/protocol"
import {
	anonymous,
	card,
	cardUrl,
	catalog,
	catalogUrl,
	etag,
	lifetimes,
	modified,
	scenarios,
	version,
	type Settings,
} from "./Scenarios.ts"
import { escape, html, introduction, page } from "./Pages.ts"
import * as Temporary from "./Temporary.ts"

const document = (
	request: HttpServerRequest.HttpServerRequest,
	value: unknown,
	contentType: string,
	extra: Readonly<Record<string, string>> = {},
) => {
	const headers = {
		"content-type": contentType,
		etag,
		"last-modified": modified,
		"cache-control": "public, max-age=60",
		...extra,
	}
	const match = request.headers["if-none-match"]
	const fresh =
		match === undefined
			? Date.parse(request.headers["if-modified-since"] ?? "") >=
				Date.parse(modified)
			: pipe(
					Str.split(match, ","),
					Arr.map(Str.trim),
					Arr.some(
						(tag) => tag === "*" || Str.replace(/^W\//, "")(tag) === etag,
					),
				)
	if (fresh) return HttpServerResponse.empty({ status: 304, headers })
	return HttpServerResponse.jsonUnsafe(value, { headers })
}

const fixtureIds = [
	"noindex",
	"robots-denied",
	"unlisted",
	"withdrawn",
	"malformed",
	"incompatible",
	"redirect",
	"unavailable",
]
export const layer = ({ origin, guideMarkdown }: Settings) => {
	const fixtureCard = (id: string) => ({
		...card(origin)(anonymous),
		name: "openbot.protocol-test/" + id,
		title: "Protocol Test · " + id,
		...(id === "incompatible"
			? {
					remotes: [
						{
							type: "sse",
							url: origin + "/legacy",
							supportedProtocolVersions: ["2024-11-05"],
						},
					],
				}
			: {}),
	})
	const rows = pipe(
		scenarios,
		Arr.map(
			(scenario) =>
				`<tr><td><a href="/apps/${scenario.id}">${escape(scenario.title)}</a></td><td>${escape(scenario.description)}</td></tr>`,
		),
		Arr.join(""),
	)
	const fixtureLinks = pipe(
		fixtureIds,
		Arr.map(
			(id) => `<li><a href="/fixtures/${id}/server-card.json">${id}</a></li>`,
		),
		Arr.join(""),
	)
	const rootCatalog = {
		...catalog(origin)(),
		entries: [
			...catalog(origin)().entries,
			...Arr.map(["noindex", "robots-denied"], (id) => ({
				identifier: "openbot.protocol-test/" + id,
				type: Document.cardMediaType,
				url: origin + `/fixtures/${id}/server-card.json`,
			})),
		],
	}
	return Layer.mergeAll(
		HttpRouter.add(
			"GET",
			"/guide",
			Effect.succeed(
				html(
					page("OpenBot App Protocol test guide")(
						`<main><pre>${escape(guideMarkdown)}</pre></main>`,
					),
				)(),
			),
		),
		HttpRouter.add("GET", "/.well-known/ai-catalog.json", (request) =>
			Effect.succeed(document(request, rootCatalog, Document.catalogMediaType)),
		),
		HttpRouter.add("GET", "/scenarios.json", (request) =>
			Effect.succeed(
				document(
					request,
					{
						name: "OpenBot App Protocol Test Service",
						version,
						origin,
						protocolVersion: Document.protocolVersion,
						appsVersion: Document.appsVersion,
						state: {
							synthetic: true,
							persistent: false,
							workspaceTtlSeconds: Duration.toSeconds(lifetimes.workspace),
							tokenTtlSeconds: Duration.toSeconds(lifetimes.access),
							refreshTtlSeconds: Duration.toSeconds(lifetimes.refresh),
							capacity: Temporary.capacity,
						},
						scenarios: Arr.map(scenarios, (scenario) => ({
							...scenario,
							introduction: origin + `/apps/${scenario.id}`,
							card: cardUrl(origin)(scenario),
							catalog: catalogUrl(origin)(scenario),
							mcp: origin + "/mcp/" + scenario.id,
						})),
						fixtures: Arr.map(fixtureIds, (id) => ({
							id,
							card: origin + `/fixtures/${id}/server-card.json`,
						})),
					},
					"application/json",
				),
			),
		),
		HttpRouter.add(
			"GET",
			"/healthz",
			Effect.succeed(HttpServerResponse.jsonUnsafe({ status: "ok", version })),
		),
		HttpRouter.add(
			"GET",
			"/readyz",
			Effect.succeed(
				HttpServerResponse.jsonUnsafe({ status: "ready", version }),
			),
		),
		HttpRouter.add(
			"GET",
			"/robots.txt",
			Effect.succeed(
				HttpServerResponse.text(
					"User-agent: *\nAllow: /\nDisallow: /fixtures/robots-denied/\n",
				),
			),
		),
		HttpRouter.add(
			"GET",
			"/assets/icon.svg",
			Effect.succeed(
				HttpServerResponse.text(
					'<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><rect width="128" height="128" rx="28" fill="#134e4a"/><text x="64" y="87" text-anchor="middle" font-family="system-ui,sans-serif" font-size="76" fill="white">P</text></svg>',
					{
						contentType: "image/svg+xml",
						headers: { "cache-control": "public, max-age=3600" },
					},
				),
			),
		),
		HttpRouter.add(
			"GET",
			"/",
			Effect.succeed(
				html(
					page("OpenBot App Protocol Test Service")(
						`<main><h1>OpenBot App Protocol Test Service</h1><p>Public test Apps for discovery, credentials, OAuth, MCP and MCP Apps.</p><p>Use only made-up data. Temporary workspaces expire after 30 minutes. A restart clears all state.</p><p><a href="/.well-known/ai-catalog.json">AI Catalog</a> · <a href="/scenarios.json">Machine-readable scenarios</a> · <a href="/guide">Test guide</a></p><table><thead><tr><th>Scenario</th><th>Purpose</th></tr></thead><tbody>${rows}</tbody></table><h2>Discovery failures and indexing</h2><ul>${fixtureLinks}</ul></main>`,
						'<link rel="ai-catalog" type="application/ai-catalog+json" href="/.well-known/ai-catalog.json">',
					),
				)({
					headers: {
						link: `<${origin}/.well-known/ai-catalog.json>; rel="ai-catalog"; type="${Document.catalogMediaType}"`,
					},
				}),
			),
		),
		...Arr.map(scenarios, (scenario) =>
			HttpRouter.add(
				"GET",
				`/apps/${scenario.id}`,
				Effect.succeed(
					html(introduction(origin)(scenario))({
						headers: {
							link: `<${catalogUrl(origin)(scenario)}>; rel="ai-catalog"; type="${Document.catalogMediaType}"`,
						},
					}),
				),
			),
		),
		...Arr.map(fixtureIds, (id) =>
			HttpRouter.add("GET", `/fixtures/${id}/server-card.json`, (request) => {
				if (id === "withdrawn")
					return Effect.succeed(HttpServerResponse.empty({ status: 410 }))
				if (id === "unavailable")
					return Effect.succeed(
						HttpServerResponse.empty({
							status: 503,
							headers: { "retry-after": "60" },
						}),
					)
				if (id === "redirect")
					return Effect.succeed(
						HttpServerResponse.empty({
							status: 302,
							headers: { location: cardUrl(origin)(anonymous) },
						}),
					)
				if (id === "malformed")
					return Effect.succeed(
						HttpServerResponse.text('{"broken":', {
							contentType: Document.cardMediaType,
						}),
					)
				return Effect.succeed(
					document(
						request,
						fixtureCard(id),
						Document.cardMediaType,
						id === "noindex" ? { "x-robots-tag": "noindex" } : {},
					),
				)
			}),
		),
		HttpRouter.add(
			"GET",
			"/elicitation/:id",
			Effect.succeed(
				html(
					page("Test URL elicitation")(
						"<main><h1>Test URL elicitation</h1><p>This page shows that the host opened the requested URL. It does not give access or change business state. Go back to the host. Then accept, decline or cancel its pending input request.</p></main>",
					),
				)(),
			),
		),
	)
}
