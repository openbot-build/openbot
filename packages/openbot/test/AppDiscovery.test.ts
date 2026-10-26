import * as BotFixture from "./BotFixture.ts"
import * as TriggerStore from "../src/triggers/Triggers.ts"
import * as Channels from "../src/channels/Channels.ts"
import { ComputerProviders } from "../src/computers/ComputerProviders.ts"
import { Computers } from "../src/computers/Computers.ts"
import { Coordinator } from "../src/bots/Coordinator.ts"
import { Connectors } from "../src/computers/connector/Connectors.ts"
import { Drivers } from "../src/computers/Drivers.ts"
import { Pairings } from "../src/computers/Pairings.ts"
import { Sessions } from "../src/computers/Sessions.ts"
import { SecretProviders } from "../src/vaults/SecretProviders.ts"
import { Vaults } from "../src/vaults/Vaults.ts"
import { Files } from "../src/files/Files.ts"
import * as ChannelQueue from "../src/channels/ChannelQueue.ts"
import * as ChannelRegistry from "../src/channels/ChannelRegistry.ts"
import * as DeveloperLayers from "../src/apps/DeveloperLayers.ts"
import * as AppExperience from "../src/apps/Experience.ts"
import * as Views from "../src/apps/Views.ts"
import * as LiveSessions from "../src/chats/live/LiveSessions.ts"
import { assert, layer } from "@effect/vitest"
import { PgClient } from "@effect/sql-pg"
import {
	Array as Arr,
	Context,
	Deferred,
	Effect,
	Layer,
	Result,
	Redacted,
	Ref,
	Schema,
	String as Str,
} from "effect"
import {
	AppConnections,
	CatalogDiscovery,
	Document,
	Discovery,
	Network,
} from "@openbot-build/protocol"
import * as NodeHttpServer from "@openbot-build/protocol/NodeHttpServer"
// @effect-diagnostics-next-line nodeBuiltinImport:off -- NodeHttpServer.layer needs a function that makes a Node HTTP server.
import { createServer } from "node:http"
import {
	NodeHttpServer as PlatformHttpServer,
	NodeServices,
	NodeCrypto,
} from "@effect/platform-node"
import {
	FetchHttpClient,
	HttpClient,
	HttpClientRequest,
	HttpClientResponse,
	HttpRouter,
	HttpServer,
	HttpServerRequest,
	HttpServerResponse,
} from "effect/http"
import * as Client from "@openbot-build/client"
import { Server, Auth, DatabasePostgres } from "../src/index.ts"
// The migrations come through the entry point of the package, so the test checks that export too.
import * as Migration from "@openbot-build/openbot/StorageMigration"
import * as Connections from "../src/apps/Connections.ts"
import * as Authorizations from "../src/apps/Authorizations.ts"
import * as ProtocolStores from "../src/apps/ProtocolStores.ts"
import * as AppHost from "../src/apps/AppHost.ts"
import * as Invocations from "../src/apps/Invocations.ts"
import * as Operations from "../src/apps/Operations.ts"
import { CodeRuns } from "../src/code/CodeRuns.ts"
import * as ActionPolicy from "../src/apps/ActionPolicy.ts"
import * as Lifecycle from "../src/apps/Lifecycle.ts"
import * as ConnectionLocks from "../src/apps/ConnectionLocks.ts"
import * as Capabilities from "../src/apps/Capabilities.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import * as Probe from "../src/apps/Probe.ts"
import * as DomainControl from "../src/apps/DomainControl.ts"
import * as OutboundPolicy from "../src/network/OutboundPolicy.ts"
import * as TokensPostgres from "../src/auth/TokensPostgres.ts"
import * as OrganizationFixture from "./OrganizationFixture.ts"
import * as PostgresTest from "./PostgresTest.ts"
import { serveHttps } from "../../protocol/test/Fixture.ts"
import { Backend } from "../src/app/Backend.ts"
import {
	AuthApi,
	DeveloperApi,
	AppDiscoveryFailed,
	AppDiscoveryResult,
} from "@openbot-build/api"
import * as AppDiscovery from "../src/apps/Discovery.ts"
import * as Governance from "../src/apps/Governance.ts"
import * as PublicIndex from "../src/apps/Index.ts"
import * as IndexStore from "../src/apps/IndexStore.ts"

/** The Node services for the test servers, and an HTTP client to call them. */
const platform = Layer.merge(NodeServices.layer, FetchHttpClient.layer)

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
	const server = yield* serveHttps(app)
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

const startApi = Effect.fn("AppDiscoveryTest.startApi")(function* (
	discovery: Layer.Layer<Discovery.Discovery>,
	publicNetwork?: Layer.Layer<Network.PublicNetwork>,
) {
	const database = yield* PostgresTest.start
	// The migration has its own database pool. It closes after the migration.
	yield* DatabasePostgres.migrate.pipe(
		Effect.provide(
			DatabasePostgres.layer({
				databaseUrl: Redacted.make(database.url),
			}).pipe(Layer.provide(NodeServices.layer)),
		),
	)
	const authCalls = yield* Ref.make<ReadonlyArray<string>>([])
	const identity = {
		userId: "local-user",
		organizationId: "local-organization",
	}
	const auth = Auth.Auth.of({
		handler: () =>
			Promise.reject(new Error("Discovery must not call Better Auth routes")),
		signInProvider: () => Effect.succeedNone,
		startSignIn: () => Effect.die("Discovery must not start a sign-in"),
		resolveSession: (credential) =>
			Effect.gen(function* () {
				yield* Ref.update(authCalls, Arr.append("session"))
				if (Redacted.value(credential) === "unavailable")
					return yield* Auth.Model.AuthUnavailable.make({
						dependency: "storage",
					})
				if (Redacted.value(credential) !== "local-session")
					return yield* Auth.Model.CredentialRejected.make({ kind: "session" })
				return {
					userId: identity.userId,
					profile: {},
					memberships: [
						{
							organizationId: identity.organizationId,
							name: "Local",
							status: "active" as const,
							roles: ["super_administrator"],
						},
					],
					platformAdmin: false,
					expiresAt: "2099-01-01T00:00:00.000Z",
					setCookies: [],
				}
			}),
	})
	const encryptionKey = Redacted.make("test:" + Str.repeat(32)("11"))
	const settings = OrganizationFixture.layerSettings({ publicOrigin })
	const services = yield* Layer.build(
		HttpRouter.serve(Server.layerApi).pipe(
			Layer.provide([
				discovery,
				DeveloperLayers.layer.pipe(
					Layer.provide(
						Layer.mergeAll(
							publicNetwork ?? OutboundPolicy.layerPublicNetwork,
							DomainControl.layer,
							AppHost.layerNetwork,
						),
					),
					Layer.provide(
						Governance.layer.pipe(
							Layer.provide(OrganizationFixture.layerDefaultSettings),
						),
					),
					Layer.provide(Secrets.layer(encryptionKey)),
					Layer.provide(discovery),
					Layer.provide(IndexStore.layer),
				),
				Layer.mergeAll(
					AppExperience.layer.pipe(Layer.provideMerge(Lifecycle.layer)),
					Lifecycle.layer,
					Authorizations.layer,
					Operations.layer,
					Views.layer.pipe(Layer.provide(Layer.mock(Backend, {}))),
					Layer.mock(CodeRuns, {
						settings: Effect.succeedNone,
						vault: Effect.succeed([]),
						stale: Effect.succeed([]),
					}),
				).pipe(
					Layer.provideMerge(Invocations.layer),
					Layer.provide(
						ActionPolicy.layer.pipe(
							Layer.provide(OrganizationFixture.layerDefaultSettings),
						),
					),
					Layer.provideMerge(Connections.layer),
					Layer.provideMerge(Capabilities.layer),
					Layer.provide(AppHost.layer),
					Layer.provide(discovery),
					Layer.provide(CatalogDiscovery.layerRules),
					Layer.provide(Probe.layer),
					Layer.provide(
						Governance.layer.pipe(
							Layer.provide(OrganizationFixture.layerDefaultSettings),
						),
					),
					Layer.provide(AppHost.layerNetwork),
					Layer.provideMerge(AppConnections.layerConnectionScopes),
					Layer.provide(ConnectionLocks.layer),
					Layer.provide(NodeCrypto.layer),
					Layer.provideMerge(ProtocolStores.layer),
					Layer.provideMerge(Secrets.layer(encryptionKey)),
				),
				PublicIndex.layer({}).pipe(
					Layer.provide(
						Governance.layer.pipe(
							Layer.provide(OrganizationFixture.layerDefaultSettings),
						),
					),
					Layer.provide(IndexStore.layer),
				),
				TokensPostgres.layer,
				// The triggers take the authorizer when they are built.
				TriggerStore.layer.pipe(
					Layer.provide(OrganizationFixture.layerAuthorization),
					Layer.provide(TokensPostgres.layer),
				),
				ChannelRegistry.layer.pipe(
					Layer.provideMerge(ChannelQueue.layer),
					Layer.provideMerge(Channels.layer),
					Layer.provide(
						Layer.merge(FetchHttpClient.layer, AppHost.layerNetwork),
					),
					Layer.provide(Secrets.layer(encryptionKey)),
				),
				OrganizationFixture.layerEveryoneAdministrator,
				OrganizationFixture.layerNoAudit,
				OrganizationFixture.layerUnusedPlatform,
				// The settings of the platform win over the empty ones of the line above.
				settings,
				Secrets.layer(encryptionKey),
				BotFixture.layerBotServices.pipe(
					Layer.provide(OrganizationFixture.layerAuthorization),
					Layer.provide(TokensPostgres.layer),
				),
				Layer.succeed(Auth.Auth, auth),
				Layer.mock(Backend, {}),
				// Discovery never uses Computers. Their handlers only need the services to exist.
				Layer.mock(ComputerProviders, {}),
				Layer.mock(Computers, {}),
				Layer.mock(Connectors, {}),
				Layer.mock(Drivers, {}),
				// Discovery never uses Vaults. Their handlers only need the services to exist.
				Layer.mergeAll(Layer.mock(Vaults, {}), Layer.mock(SecretProviders, {})),
				Layer.mock(Pairings, {}),
				Layer.mock(Sessions, {}),
				// Discovery never uses files. Their handlers only need the service to exist.
				Layer.mock(Files, {}),
				// Discovery never uses Chats. Their handlers only need the Coordinator to exist.
				Layer.mock(Coordinator, {}),
				// The Live handlers take the open Live sessions when they are built.
				LiveSessions.layer,
			]),
			// The services above read the public origin from these settings.
			Layer.provide(settings),
			Layer.provideMerge(
				DatabasePostgres.layer({
					databaseUrl: Redacted.make(database.url),
				}).pipe(Layer.provide(NodeServices.layer)),
			),
			Layer.provideMerge(
				PlatformHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }),
			),
		),
	)
	yield* Effect.provideContext(Migration.initialize, services)
	const address = HttpServer.formatAddress(
		Context.get(services, HttpServer.HttpServer).address,
	)
	const sql = Context.get(services, PgClient.PgClient)
	return {
		address,
		sql: (statement: string) => sql.unsafe(statement),
		/** Every session that the server asked Auth to resolve. */
		authCalls: Ref.get(authCalls),
		request: (payload: unknown, headers: Record<string, string> = {}) =>
			postJson(address + "/v1/apps/discover", payload, headers),
	}
})

layer(platform, { excludeTestServices: true })((it) => {
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
				yield* Schema.decodeEffect(AppDiscoveryResult)(multiple)
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
				const services = yield* Layer.build(AppDiscovery.layerPublic)
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
				const session = { cookie: `${AuthApi.SessionCookie}=local-session` }
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
						[
							{
								cookie: `${AuthApi.SessionCookie}=unavailable`,
								origin: publicOrigin,
							},
							503,
						],
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
					yield* HttpClientResponse.schemaBodyJson(AppDiscoveryResult)(response)
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
				const browser = {
					cookie: `${AuthApi.SessionCookie}=local-session`,
					origin: publicOrigin,
				}
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
					Effect.flatMap(
						response.json,
						Schema.decodeUnknownEffect(AppDiscoveryFailed),
					)
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
					assert.ok(Schema.is(AppDiscoveryFailed)(result.failure))
					assert.strictEqual(result.failure.reason, reason)
				}
				const publicApi = yield* startApi(AppDiscovery.layerPublic)
				const rejected = yield* publicApi.request(
					{ input: publisher.origin + "/card?edition=team" },
					browser,
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
				const headers = {
					cookie: `${AuthApi.SessionCookie}=local-session`,
					origin: publicOrigin,
				}
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
				const authCalls = (yield* api.authCalls).length
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
				assert.strictEqual((yield* api.authCalls).length, authCalls)
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
