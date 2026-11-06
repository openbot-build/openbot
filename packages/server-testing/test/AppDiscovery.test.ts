import { Result as ResultModel } from "@openbot-build/protocol/Discovery"
import { Failed } from "@openbot-build/domain/AppDiscovery"
import { assert, layer } from "@effect/vitest"
import { PgClient } from "@effect/sql-pg"
import {
	Array as Arr,
	Deferred,
	Effect,
	HashSet,
	Layer,
	Order,
	Result,
	Ref,
	Schema,
	String as Str,
} from "effect"
import {
	CatalogDiscovery,
	Document,
	Discovery,
	Network,
} from "@openbot-build/protocol"
import * as NodeHttpServer from "@openbot-build/protocol/NodeHttpServer"
import { NodeCrypto, NodeServices } from "@effect/platform-node"
import {
	FetchHttpClient,
	HttpClient,
	HttpClientRequest,
	HttpClientResponse,
	HttpServerRequest,
	HttpServerResponse,
} from "effect/http"
import * as Client from "@openbot-build/client"
import * as BrowserHost from "../src/BrowserHost.ts"
import * as Caller from "../src/Caller.ts"
import * as AppsOutside from "@openbot-build/plugin-apps/Outside"
import { Fixture } from "@openbot-build/protocol/testing"
import { AuthApi, DeveloperApi, OpenBotApi } from "@openbot-build/api"
import { HttpApi } from "effect/http-api"
import * as HttpHost from "@openbot-build/server-kernel/HttpHost"
import * as AppDiscovery from "@openbot-build/plugin-apps/Discovery"
import * as PublicIndex from "@openbot-build/plugin-apps/AppIndex"

/** The Node services for the test servers, and an HTTP client to call them. */
const platform = Layer.mergeAll(
	NodeServices.layer,
	NodeCrypto.layer,
	FetchHttpClient.layer,
)

/** A body given as text, with the JSON content type. */
const jsonText = (body: string, status = 200) =>
	HttpServerResponse.text(body, { status, contentType: "application/json" })

// These tests check runtime boundaries. All protocol traffic stays in local fixtures.
const fixture = Effect.fn("AppDiscoveryTest.fixture")(function* () {
	const requests = yield* Ref.make<ReadonlyArray<string>>([])
	/** Broken rules of the fixture. They fail the test when the scope closes. */
	const problems = yield* Ref.make<ReadonlyArray<string>>([])
	yield* Effect.addFinalizer(() =>
		Effect.flatMap(Ref.get(problems), (found) =>
			Arr.isReadonlyArrayNonEmpty(found)
				? Effect.die(new Error(Arr.join(found, "\n")))
				: Effect.void,
		),
	)
	/** The origin of the server. It is known when the server listens. */
	const origin = yield* Deferred.make<string>()
	const card = (base: string, name: string) => ({
		$schema: Document.cardSchemaUrl,
		name,
		version: "1.0.0",
		description: "Local App fixture",
		remotes: [
			{
				type: "streamable-http",
				url: `${base}/mcp`,
				supportedProtocolVersions: [Document.protocolVersion],
				headers: [
					{
						name: "X-Account",
						isRequired: true,
						description: "Account name",
					},
				],
			},
		],
		_meta: { "fixture.test/metadata": { preserved: true } },
	})
	const catalog = (base: string, urls: ReadonlyArray<string>) => ({
		specVersion: "1.0",
		entries: Arr.map(urls, (url, index) => ({
			identifier: String(index),
			type: Document.cardMediaType,
			url: base + url,
		})),
	})
	const index = (base: string, second: boolean) => {
		const cardUrl = base + (second ? "/second" : "/card?edition=team")
		return {
			apps: [
				{
					entry: {
						cardUrl,
						card: card(
							base,
							second ? "fixture.test/second" : "fixture.test/first",
						),
						evidence: [
							{
								publisherUrl: base,
								catalogUrl: base + "/.well-known/ai-catalog.json",
								cardUrl,
								association: "CardOrigin",
							},
						],
						checkedAt: 1000,
						validators: {},
					},
					sources: [],
					matches: [],
				},
			],
			issues: [],
			nextCursor: second ? null : "second",
		}
	}
	const app = Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest
		const base = yield* Deferred.await(origin)
		if (
			request.headers["authorization"] !== undefined ||
			request.headers["cookie"] !== undefined
		) {
			const problem = "A discovery request got account credentials"
			yield* Ref.update(problems, Arr.append(problem))
			return yield* Effect.die(new Error(problem))
		}
		yield* Ref.update(requests, Arr.append(request.url))
		const requestUrl = new URL(request.url, base)
		if (requestUrl.pathname === "/index")
			return yield* HttpServerResponse.json(
				index(base, requestUrl.searchParams.has("cursor")),
			)
		switch (request.url) {
			case "/robots.txt":
				return jsonText("", 404)
			case "/.well-known/ai-catalog.json":
				return yield* HttpServerResponse.json(
					catalog(base, ["/card?edition=team"]),
				)
			case "/catalog":
				return yield* HttpServerResponse.json(
					catalog(base, ["/card?edition=team", "/second", "/invalid"]),
				)
			case "/card?edition=team":
				return yield* HttpServerResponse.json(card(base, "fixture.test/first"))
			case "/second":
				return yield* HttpServerResponse.json(card(base, "fixture.test/second"))
			case "/page?edition=team":
				return HttpServerResponse.text(
					'<head><link rel="ai-catalog" href="/.well-known/ai-catalog.json"></head>',
					{ contentType: "text/html" },
				)
			case "/none":
				return HttpServerResponse.text("<head></head>", {
					contentType: "text/html",
				})
			case "/empty":
				return yield* HttpServerResponse.json(catalog(base, []))
			case "/invalid":
				return HttpServerResponse.text("{}", {
					contentType: Document.cardMediaType,
				})
			case "/malformed":
				return jsonText("{")
			case "/incompatible":
				return yield* HttpServerResponse.json({
					...card(base, "fixture.test/old"),
					remotes: [],
				})
			case "/redirect":
				return HttpServerResponse.redirect("https://127.0.0.1:1/forbidden", {
					status: 302,
				})
			case "/large":
				return jsonText(Str.repeat(20000)("x"))
			default:
				return jsonText("Unavailable", 503)
		}
	})
	const server = yield* Fixture.serveHttps(app)
	yield* Deferred.succeed(origin, server.ipOrigin)
	const network = NodeHttpServer.layerUserNetwork({
		owner: "local-fixture",
		allowedOrigins: [server.ipOrigin],
		allowAddress: (ip) => ip === "127.0.0.1",
		ca: server.ca,
		maxBytes: 10000,
	})
	return {
		origin: server.ipOrigin,
		/** Every request URL that the publisher got, in order. */
		requests: Ref.get(requests),
		layer: CatalogDiscovery.layer().pipe(
			Layer.provide(CatalogDiscovery.layerRules),
			Layer.provide(network),
		),
		publicNetwork: Layer.effect(
			Network.PublicNetwork,
			Effect.map(Network.Network, (value) =>
				Network.PublicNetwork.of({ readDocument: value.readDocument }),
			),
		).pipe(Layer.provide(network)),
	}
})

const publicOrigin = "https://openbot.fixture.test"

/** The part of the OpenAPI document that the test reads. */
const DiscoverOperation = Schema.Struct({
	paths: Schema.Struct({
		"/v1/apps/discover": Schema.Struct({
			post: Schema.Struct({
				security: Schema.Array(
					Schema.Record(Schema.String, Schema.Array(Schema.String)),
				),
				responses: Schema.Record(Schema.String, Schema.Unknown),
			}),
		}),
	}),
})

/** Sends a JSON body to the server. */
const postJson = (
	url: string,
	payload: unknown,
	headers: Record<string, string> = {},
) =>
	HttpClientRequest.post(url, { headers }).pipe(
		HttpClientRequest.bodyJson(payload),
		Effect.flatMap(HttpClient.execute),
	)

/** Reads the body of a GET answer as text. */
const getText = (url: string, headers: Record<string, string> = {}) =>
	Effect.flatMap(HttpClient.get(url, { headers }), (response) => response.text)

/**
 * Starts a whole test host whose App discovery and public network are these
 * fakes, and signs in one person.
 */
const startApi = Effect.fn("AppDiscoveryTest.startApi")(function* (
	discovery: Layer.Layer<Discovery.Discovery>,
	publicNetwork?: Layer.Layer<Network.PublicNetwork>,
) {
	const host = yield* BrowserHost.start({
		publicOrigin,
		discovery,
		indexPublicNetwork: publicNetwork,
	})
	const user = yield* host.login("local")
	const address = yield* host.address
	return {
		address,
		/** The cookie header of the session of the person. */
		cookie: Caller.sessionCookie(user.session),
		sql: (statement: string) =>
			host.run(
				Effect.flatMap(PgClient.PgClient, (sql) => sql.unsafe(statement)),
			),
		/** The groups of the contract that the host mounted. */
		mounted: host.run(
			Effect.flatMap(HttpHost.HttpHost, (http) => http.mounted),
		),
		request: (payload: unknown, headers: Record<string, string> = {}) =>
			postJson(address + "/v1/apps/discover", payload, headers),
	}
})

layer(platform, { excludeTestServices: true })((it) => {
	it.effect("the test host mounts every group of the contract", () =>
		Effect.gen(function* () {
			const publisher = yield* fixture()
			const api = yield* startApi(publisher.layer)
			let groups = HashSet.empty<string>()
			HttpApi.reflect(OpenBotApi, {
				onGroup: ({ group }) => {
					groups = HashSet.add(groups, group.identifier)
				},
				onEndpoint: () => undefined,
			})
			assert.strictEqual(HashSet.size(groups), 46)
			assert.deepStrictEqual(
				Arr.sort(Arr.fromIterable(yield* api.mounted), Order.String),
				Arr.sort(Arr.fromIterable(groups), Order.String),
			)
		}),
	)

	it.effect(
		"known-address discovery keeps protocol candidates, configuration and sources from local HTTPS",
		() =>
			Effect.gen(function* () {
				const publisher = yield* fixture()
				const services = yield* Layer.build(publisher.layer)
				const discover = (input: string) =>
					Effect.provideContext(AppDiscovery.discover(input), services)
				const single = yield* discover(Str.slice(8)(publisher.origin))
				assert.strictEqual(single._tag, "Single")
				assert.ok(single._tag === "Single")
				assert.strictEqual(
					single.candidate.cardUrl,
					publisher.origin + "/card?edition=team",
				)
				assert.strictEqual(
					single.candidate.endpoints[0]?.requirements[0]?.key,
					"header:X-Account",
				)
				assert.deepStrictEqual(single.candidate.card._meta, {
					"fixture.test/metadata": { preserved: true },
				})
				assert.deepStrictEqual(
					Arr.map(single.candidate.sources, (source) => source.role),
					["input", "catalog", "card", "endpoint"],
				)
				const multiple = yield* discover(publisher.origin + "/catalog")
				assert.ok(multiple._tag === "Multiple")
				assert.strictEqual(multiple.candidates.length, 2)
				assert.strictEqual(multiple.issues.length, 1)
				assert.strictEqual(
					multiple.issues[0]?.url,
					publisher.origin + "/invalid",
				)
				yield* Schema.decodeEffect(ResultModel)(multiple)
				const page = yield* discover(publisher.origin + "/page?edition=team")
				assert.ok(page._tag === "Single")
				assert.strictEqual(
					page.candidate.sources[0]?.originalInput,
					publisher.origin + "/page?edition=team",
				)
				const requests = yield* publisher.requests
				assert.ok(Arr.contains(requests, "/page?edition=team"))
				assert.strictEqual(Arr.contains(requests, "/mcp"), false)
			}),
	)

	it.effect(
		"extra public Index sources follow HTTPS pages without sending credentials",
		() =>
			Effect.gen(function* () {
				const publisher = yield* fixture()
				const network = yield* Layer.build(publisher.publicNetwork)
				const provider = yield* Effect.provideContext(
					PublicIndex.remoteProvider({
						id: "remote",
						name: "Remote Index",
						url: publisher.origin + "/index",
						simulated: true,
					}),
					network,
				)
				const entries = yield* provider.entries
				assert.strictEqual(entries.length, 2)
				assert.notStrictEqual(entries[0]?.cardUrl, entries[1]?.cardUrl)
				assert.deepStrictEqual(yield* publisher.requests, [
					"/index?limit=50",
					"/index?limit=50&cursor=second",
				])
			}),
	)

	it.effect(
		"discovery returns the main typed failures with local HTTP evidence",
		() =>
			Effect.gen(function* () {
				const publisher = yield* fixture()
				const services = yield* Layer.build(publisher.layer)
				const discover = (input: string) =>
					Effect.provideContext(
						Effect.result(AppDiscovery.discover(input)),
						services,
					)
				const failures: ReadonlyArray<readonly [string, string]> = [
					["/none", "NoDeclaration"],
					["/empty", "NoUsableServices"],
					["/invalid", "Document"],
					["/malformed", "Document"],
					["/incompatible", "IncompatibleCard"],
					["/unavailable", "Http"],
					["/large", "TooLarge"],
					["/redirect", "BlockedTarget"],
				]
				for (const [path, reason] of failures) {
					const result = yield* discover(publisher.origin + path)
					assert.ok(Result.isFailure(result), path)
					assert.strictEqual(result.failure._tag, "AppDiscoveryFailed")
					assert.strictEqual(result.failure.reason, reason, path)
				}
				const before = (yield* publisher.requests).length
				for (const input of [
					"not a link",
					"http://publisher.test/card",
					"https://name:secret@publisher.test/card",
				]) {
					const result = yield* discover(input)
					assert.ok(Result.isFailure(result))
					assert.strictEqual(result.failure.reason, "InvalidInput")
				}
				assert.strictEqual((yield* publisher.requests).length, before)
			}),
	)

	it.effect(
		"production discovery blocks loopback addresses before any protocol HTTP request",
		() =>
			Effect.gen(function* () {
				const publisher = yield* fixture()
				const services = yield* Layer.build(AppsOutside.layerDiscovery)
				const result = yield* Effect.provideContext(
					Effect.result(
						AppDiscovery.discover(publisher.origin + "/card?edition=team"),
					),
					services,
				)
				assert.ok(Result.isFailure(result))
				assert.strictEqual(result.failure.reason, "BlockedTarget")
				assert.strictEqual((yield* publisher.requests).length, 0)
			}),
	)

	it.effect(
		"the registered public App API checks ordinary BotAuth before it discovers local services",
		() =>
			Effect.gen(function* () {
				const publisher = yield* fixture()
				const api = yield* startApi(publisher.layer)
				const payload = { input: publisher.origin + "/card?edition=team" }
				const session = { cookie: api.cookie }
				const authenticated = { ...session, origin: publicOrigin }
				const denied: ReadonlyArray<readonly [Record<string, string>, number]> =
					[
						[{}, 401],
						[{ authorization: "Bearer wrong-key" }, 401],
						[
							{
								cookie: `${AuthApi.SessionCookie}=wrong-session`,
								origin: publicOrigin,
							},
							401,
						],
						[session, 403],
						[{ ...session, origin: "https://foreign.fixture.test" }, 403],
					]
				for (const [headers, status] of denied) {
					const response = yield* api.request(payload, headers)
					assert.strictEqual(response.status, status)
					yield* response.text
				}
				assert.strictEqual((yield* publisher.requests).length, 0)
				for (const invalid of [{}, { input: 123 }, { input: "" }]) {
					const response = yield* api.request(invalid, authenticated)
					assert.strictEqual(response.status, 400)
					yield* response.text
				}
				const malformed = yield* HttpClient.execute(
					HttpClientRequest.post(api.address + "/v1/apps/discover", {
						headers: authenticated,
					}).pipe(HttpClientRequest.bodyText("{", "application/json")),
				)
				assert.strictEqual(malformed.status, 400)
				yield* malformed.text
				assert.strictEqual((yield* publisher.requests).length, 0)
				const response = yield* api.request(
					{ input: Str.slice(8)(publisher.origin) },
					{ ...session, origin: publicOrigin },
				)
				assert.strictEqual(response.status, 200)
				const single =
					yield* HttpClientResponse.schemaBodyJson(ResultModel)(response)
				assert.ok(single._tag === "Single")
				assert.strictEqual(single.candidate.cardUrl, payload.input)
				assert.strictEqual(
					single.candidate.endpoints[0]?.requirements[0]?.key,
					"header:X-Account",
				)
				assert.strictEqual(
					single.candidate.sources[0]?.originalInput,
					Str.slice(8)(publisher.origin),
				)
				const spec = yield* Effect.flatMap(
					HttpClient.get(api.address + "/openapi.json"),
					HttpClientResponse.schemaBodyJson(DiscoverOperation),
				)
				const operation = spec.paths["/v1/apps/discover"].post
				assert.deepStrictEqual(operation.security, [
					{ token: [] },
					{ session: [] },
				])
				for (const status of ["200", "400", "401", "403", "422", "503"])
					assert.ok(operation.responses[status])
				assert.strictEqual(
					(yield* HttpClient.get(api.address + "/health")).status,
					200,
				)
				assert.strictEqual(
					Arr.contains(yield* publisher.requests, "/mcp"),
					false,
				)
			}),
	)

	it.effect(
		"shared public client decodes real HTTP discovery results and typed protocol failures",
		() =>
			Effect.gen(function* () {
				const publisher = yield* fixture()
				const api = yield* startApi(publisher.layer)
				const browser = { cookie: api.cookie, origin: publicOrigin }
				const client = yield* Layer.build(
					Client.layer({ baseUrl: api.address }),
				)
				// The client sends the session cookie and the origin of a browser.
				const discover = (input: string) =>
					Client.Client.use((client) =>
						client.api.apps.discoverApp({ payload: { input } }),
					).pipe(
						Effect.provideContext(client),
						Effect.provideService(FetchHttpClient.RequestInit, {
							headers: browser,
						}),
					)
				const failureOf = (response: HttpClientResponse.HttpClientResponse) =>
					Effect.flatMap(response.json, Schema.decodeUnknownEffect(Failed))
				const multiple = yield* discover(publisher.origin + "/catalog")
				assert.ok(multiple._tag === "Multiple")
				assert.strictEqual(multiple.candidates.length, 2)
				assert.strictEqual(
					multiple.issues[0]?.url,
					publisher.origin + "/invalid",
				)
				const failures: ReadonlyArray<readonly [string, string]> = [
					["not a link", "InvalidInput"],
					[publisher.origin + "/none", "NoDeclaration"],
					[publisher.origin + "/empty", "NoUsableServices"],
					[publisher.origin + "/invalid", "Document"],
					[publisher.origin + "/malformed", "Document"],
					[publisher.origin + "/incompatible", "IncompatibleCard"],
					[publisher.origin + "/unavailable", "Http"],
					[publisher.origin + "/large", "TooLarge"],
					[publisher.origin + "/redirect", "BlockedTarget"],
				]
				for (const [input, reason] of failures) {
					const response = yield* api.request({ input }, browser)
					assert.strictEqual(response.status, 422)
					const failure = yield* failureOf(response)
					assert.strictEqual(failure.reason, reason)
					const result = yield* Effect.result(discover(input))
					assert.ok(Result.isFailure(result))
					assert.ok(Schema.is(Failed)(result.failure))
					assert.strictEqual(result.failure.reason, reason)
				}
				const publicApi = yield* startApi(AppsOutside.layerDiscovery)
				const rejected = yield* publicApi.request(
					{ input: publisher.origin + "/card?edition=team" },
					{ cookie: publicApi.cookie, origin: publicOrigin },
				)
				assert.strictEqual(rejected.status, 422)
				assert.strictEqual((yield* failureOf(rejected)).reason, "BlockedTarget")
			}),
	)

	it.effect(
		"anonymous developer inspection uses its own HTTPS evidence and does not change connections or the Index",
		() =>
			Effect.gen(function* () {
				const publisher = yield* fixture()
				const api = yield* startApi(publisher.layer, publisher.publicNetwork)
				const headers = { cookie: api.cookie, origin: publicOrigin }
				const inventory = yield* getText(
					api.address + "/v1/connections",
					headers,
				)
				const index = yield* getText(api.address + "/v1/app-index/apps")
				const inspect = (input: string) =>
					Effect.gen(function* () {
						const response = yield* postJson(
							api.address + "/v1/developer/inspect",
							{ input },
						)
						assert.strictEqual(response.status, 200, yield* response.text)
						return yield* HttpClientResponse.schemaBodyJson(
							DeveloperApi.InspectionReport,
						)(response)
					})
				const single = yield* inspect(publisher.origin + "/card?edition=team")
				assert.strictEqual(single.apps[0]?.eligibility._tag, "Eligible")
				assert.ok(
					Arr.some(
						single.stages,
						(stage) =>
							stage.name === "Eligibility" && stage.status === "Passed",
					),
				)
				yield* api.sql(
					"ALTER TABLE openbot_app_index_entries RENAME TO unavailable_index_entries",
				)
				yield* Effect.gen(function* () {
					const unknown = yield* inspect(
						publisher.origin + "/card?edition=team",
					)
					assert.strictEqual(unknown.apps[0]?.eligibility._tag, "Eligible")
					assert.strictEqual(unknown.apps[0]?.stored._tag, "Unknown")
				}).pipe(
					Effect.ensuring(
						Effect.orDie(
							api.sql(
								"ALTER TABLE unavailable_index_entries RENAME TO openbot_app_index_entries",
							),
						),
					),
				)

				const multiple = yield* inspect(publisher.origin + "/catalog")
				assert.strictEqual(multiple.apps.length, 2)
				assert.ok(
					Arr.some(
						multiple.issues,
						(issue) => issue.code === "InvalidCandidate",
					),
				)
				for (const path of ["/empty", "/none", "/malformed", "/redirect"]) {
					const report = yield* inspect(publisher.origin + path)
					assert.strictEqual(report.apps.length, 0)
					assert.ok(report.issues.length > 0)
					assert.ok(
						Arr.some(report.stages, (stage) => stage.status === "NotChecked"),
					)
				}
				const count = (yield* publisher.requests).length
				const invalid = yield* postJson(api.address + "/v1/developer/inspect", {
					input: "http://insecure.example/card",
				})
				assert.strictEqual(invalid.status, 400)
				assert.strictEqual((yield* publisher.requests).length, count)
				assert.strictEqual(
					Arr.contains(yield* publisher.requests, "/mcp"),
					false,
				)
				assert.strictEqual(
					yield* getText(api.address + "/v1/connections", headers),
					inventory,
				)
				assert.strictEqual(
					yield* getText(api.address + "/v1/app-index/apps"),
					index,
				)
			}),
	)
})
