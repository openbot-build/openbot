import * as IndexWorkRepository from "../src/apps/IndexWorkRepositoryPostgres.ts"
import * as DeveloperLayers from "../src/apps/DeveloperLayers.ts"
import * as AppExperience from "../src/apps/Experience.ts"
import * as Views from "../src/apps/Views.ts"
import * as ViewRepository from "../src/apps/ViewRepositoryPostgres.ts"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer as createHttpsServer } from "node:https"
import { test } from "node:test"
import { PgClient } from "@effect/sql-pg"
import {
	Array as EffectArray,
	Effect,
	Layer,
	ManagedRuntime,
	Predicate,
	Result,
	Redacted,
	Schema,
} from "effect"
import {
	AppConnections,
	CatalogDiscovery,
	Document,
	Discovery,
	Network,
} from "@openbot-build/protocol"
import * as NodeHttpServer from "@openbot-build/protocol/NodeHttpServer"
import { createServer } from "node:http"
import {
	NodeHttpServer as PlatformHttpServer,
	NodeServices,
	NodeCrypto,
} from "@effect/platform-node"
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http"
import * as Client from "@openbot-build/client"
import { Server, Auth, DatabasePostgres } from "@openbot-build/platform"
import * as Migration from "@openbot-build/platform/StorageMigration"
import * as Connections from "../src/apps/Connections.ts"
import * as Authorizations from "../src/apps/Authorizations.ts"
import * as AuthorizationRepository from "../src/apps/AuthorizationRepositoryPostgres.ts"
import * as ProtocolStores from "../src/apps/ProtocolStores.ts"
import * as AppHost from "../src/apps/AppHost.ts"
import * as Invocations from "../src/apps/Invocations.ts"
import * as Operations from "../src/apps/Operations.ts"
import * as InvocationRepository from "../src/apps/InvocationRepositoryPostgres.ts"
import * as ActionPolicy from "../src/apps/ActionPolicy.ts"
import * as Lifecycle from "../src/apps/Lifecycle.ts"
import * as ConnectionLocks from "../src/apps/ConnectionLocks.ts"
import * as Capabilities from "../src/apps/Capabilities.ts"
import * as AppRepository from "../src/apps/RepositoryPostgres.ts"
import * as Secrets from "../src/apps/Secrets.ts"
import * as Probe from "../src/apps/Probe.ts"
import * as TokensPostgres from "../src/auth/TokensPostgres.ts"
import * as OrganizationFixture from "./OrganizationFixture.ts"
import * as PostgresTest from "./PostgresTest.ts"
import { Backend } from "../dist/app/Backend.js"
import {
	AuthApi,
	DeveloperApi,
	AppDiscoveryFailed,
	AppDiscoveryResult,
} from "@openbot-build/platform-api"
import * as AppDiscovery from "../src/apps/Discovery.ts"
import * as Governance from "../src/apps/Governance.ts"
import * as PublicIndex from "../src/apps/Index.ts"
import * as IndexRepository from "../src/apps/IndexRepositoryPostgres.ts"

// These tests check runtime boundaries. All protocol traffic stays in local fixtures.
const fixture = async () => {
	await mkdir(".cache/goal-manager", { recursive: true })
	const directory = await mkdtemp(".cache/goal-manager/discovery-")
	execFileSync(
		"openssl",
		[
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-days",
			"1",
			"-keyout",
			`${directory}/key.pem`,
			"-out",
			`${directory}/cert.pem`,
			"-subj",
			"/CN=localhost",
			"-addext",
			"subjectAltName=DNS:localhost,IP:127.0.0.1",
		],
		{ stdio: "ignore" },
	)
	const ca = await readFile(`${directory}/cert.pem`)
	let requests: ReadonlyArray<string> = []
	let origin = ""
	const card = (name: string) => ({
		$schema: Document.cardSchemaUrl,
		name,
		version: "1.0.0",
		description: "Local App fixture",
		remotes: [
			{
				type: "streamable-http",
				url: `${origin}/mcp`,
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
	const server = createHttpsServer(
		{ key: await readFile(`${directory}/key.pem`), cert: ca },
		(req, res) => {
			assert.equal(req.headers.authorization, undefined)
			assert.equal(req.headers.cookie, undefined)
			requests = EffectArray.append(requests, req.url ?? "")
			res.setHeader("content-type", "application/json")
			const catalog = (urls: ReadonlyArray<string>) => ({
				specVersion: "1.0",
				entries: urls.map((url, index) => ({
					identifier: String(index),
					type: Document.cardMediaType,
					url: origin + url,
				})),
			})
			const requestUrl = new URL(req.url ?? "/", origin)
			if (requestUrl.pathname === "/index") {
				const second = requestUrl.searchParams.has("cursor")
				const cardUrl = origin + (second ? "/second" : "/card?edition=team")
				res.end(
					JSON.stringify({
						apps: [
							{
								entry: {
									cardUrl,
									card: card(
										second ? "fixture.test/second" : "fixture.test/first",
									),
									evidence: [
										{
											publisherUrl: origin,
											catalogUrl: origin + "/.well-known/ai-catalog.json",
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
					}),
				)
				return
			}
			switch (req.url) {
				case "/robots.txt":
					res.statusCode = 404
					res.end()
					break
				case "/.well-known/ai-catalog.json":
					res.end(JSON.stringify(catalog(["/card?edition=team"])))
					break
				case "/catalog":
					res.end(
						JSON.stringify(
							catalog(["/card?edition=team", "/second", "/invalid"]),
						),
					)
					break
				case "/card?edition=team":
					res.end(JSON.stringify(card("fixture.test/first")))
					break
				case "/second":
					res.end(JSON.stringify(card("fixture.test/second")))
					break
				case "/page?edition=team":
					res.setHeader("content-type", "text/html")
					res.end(
						'<head><link rel="ai-catalog" href="/.well-known/ai-catalog.json"></head>',
					)
					break
				case "/none":
					res.setHeader("content-type", "text/html")
					res.end("<head></head>")
					break
				case "/empty":
					res.end(JSON.stringify(catalog([])))
					break
				case "/invalid":
					res.setHeader("content-type", Document.cardMediaType)
					res.end("{}")
					break
				case "/malformed":
					res.end("{")
					break
				case "/incompatible":
					res.end(JSON.stringify({ ...card("fixture.test/old"), remotes: [] }))
					break
				case "/redirect":
					res.writeHead(302, { location: "https://127.0.0.1:1/forbidden" })
					res.end()
					break
				case "/large":
					res.end("x".repeat(20000))
					break
				default:
					res.statusCode = 503
					res.end("Unavailable")
			}
		},
	)
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const address = server.address()
	assert.ok(Predicate.isObject(address))
	origin = `https://127.0.0.1:${address.port}`
	const network = NodeHttpServer.layerUserNetwork({
		owner: "local-fixture",
		allowedOrigins: [origin],
		allowAddress: (ip) => ip === "127.0.0.1",
		ca,
		maxBytes: 10000,
	})
	return {
		origin,
		get requests() {
			return requests
		},
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
		async [Symbol.asyncDispose]() {
			server.closeAllConnections()
			await new Promise<void>((resolve) => server.close(() => resolve()))
			await rm(directory, { recursive: true, force: true })
		},
	}
}

test("known-address discovery keeps protocol candidates, configuration and sources from local HTTPS", async () => {
	await using publisher = await fixture()
	await using runtime = ManagedRuntime.make(publisher.layer)
	const single = await runtime.runPromise(
		AppDiscovery.discover(publisher.origin.slice(8)),
	)
	assert.equal(single._tag, "Single")
	assert.ok(single._tag === "Single")
	assert.equal(
		single.candidate.cardUrl,
		publisher.origin + "/card?edition=team",
	)
	assert.equal(
		single.candidate.endpoints[0]?.requirements[0]?.key,
		"header:X-Account",
	)
	assert.deepEqual(single.candidate.card._meta, {
		"fixture.test/metadata": { preserved: true },
	})
	assert.deepEqual(
		single.candidate.sources.map((source) => source.role),
		["input", "catalog", "card", "endpoint"],
	)
	const multiple = await runtime.runPromise(
		AppDiscovery.discover(publisher.origin + "/catalog"),
	)
	assert.ok(multiple._tag === "Multiple")
	assert.equal(multiple.candidates.length, 2)
	assert.equal(multiple.issues.length, 1)
	assert.equal(multiple.issues[0]?.url, publisher.origin + "/invalid")
	await runtime.runPromise(Schema.decodeEffect(AppDiscoveryResult)(multiple))
	const page = await runtime.runPromise(
		AppDiscovery.discover(publisher.origin + "/page?edition=team"),
	)
	assert.ok(page._tag === "Single")
	assert.equal(
		page.candidate.sources[0]?.originalInput,
		publisher.origin + "/page?edition=team",
	)
	assert.ok(publisher.requests.includes("/page?edition=team"))
	assert.equal(publisher.requests.includes("/mcp"), false)
})

test("extra public Index sources follow HTTPS pages without sending credentials", async () => {
	await using publisher = await fixture()
	const runtime = ManagedRuntime.make(publisher.publicNetwork)
	try {
		const provider = await runtime.runPromise(
			PublicIndex.remoteProvider({
				id: "remote",
				name: "Remote Index",
				url: publisher.origin + "/index",
				simulated: true,
			}),
		)
		const entries = await Effect.runPromise(provider.entries)
		assert.equal(entries.length, 2)
		assert.notEqual(entries[0]?.cardUrl, entries[1]?.cardUrl)
		assert.deepEqual(publisher.requests, [
			"/index?limit=50",
			"/index?limit=50&cursor=second",
		])
	} finally {
		await runtime.dispose()
	}
})

test("discovery returns the main typed failures with local HTTP evidence", async () => {
	await using publisher = await fixture()
	await using runtime = ManagedRuntime.make(publisher.layer)
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
		const result = await runtime.runPromise(
			AppDiscovery.discover(publisher.origin + path).pipe(Effect.result),
		)
		assert.ok(Result.isFailure(result), path)
		assert.equal(result.failure._tag, "AppDiscoveryFailed")
		assert.equal(result.failure.reason, reason, path)
	}
	const before = publisher.requests.length
	for (const input of [
		"not a link",
		"http://publisher.test/card",
		"https://name:secret@publisher.test/card",
	]) {
		const result = await runtime.runPromise(
			AppDiscovery.discover(input).pipe(Effect.result),
		)
		assert.ok(Result.isFailure(result))
		assert.equal(result.failure.reason, "InvalidInput")
	}
	assert.equal(publisher.requests.length, before)
})

test("production discovery blocks loopback addresses before any protocol HTTP request", async () => {
	await using publisher = await fixture()
	await using runtime = ManagedRuntime.make(AppDiscovery.layerPublic)
	const result = await runtime.runPromise(
		AppDiscovery.discover(publisher.origin + "/card?edition=team").pipe(
			Effect.result,
		),
	)
	assert.ok(Result.isFailure(result))
	assert.equal(result.failure.reason, "BlockedTarget")
	assert.equal(publisher.requests.length, 0)
})

const publicOrigin = "https://platform.fixture.test"

const startApi = async (
	discovery: Layer.Layer<Discovery.Discovery>,
	publicNetwork?: Layer.Layer<Network.PublicNetwork>,
) => {
	const database = await PostgresTest.start()
	await using migration = ManagedRuntime.make(
		DatabasePostgres.layer({ databaseUrl: Redacted.make(database.url) }).pipe(
			Layer.provide(NodeServices.layer),
		),
	)
	await migration.runPromise(DatabasePostgres.migrate)
	let authCalls: ReadonlyArray<string> = []
	const identity = {
		userId: "local-user",
		organizationId: "local-organization",
	}
	const unused = () =>
		Effect.die("Discovery must not call account or Agent operations")
	const auth = Auth.Auth.of({
		handler: () =>
			Promise.reject(new Error("Discovery must not call Better Auth routes")),
		resolveSession: (credential) =>
			Effect.gen(function* () {
				authCalls = EffectArray.append(authCalls, "session")
				if (Redacted.value(credential) === "unavailable")
					return yield* Auth.Model.AuthUnavailable.make({
						dependency: "storage",
					})
				if (Redacted.value(credential) !== "local-session")
					return yield* Auth.Model.CredentialRejected.make({ kind: "session" })
				return {
					identity,
					profile: {},
					expiresAt: "2099-01-01T00:00:00.000Z",
					setCookies: [],
				}
			}),
	})
	const runtime = ManagedRuntime.make(
		HttpRouter.serve(Server.layerApi({ publicOrigin })).pipe(
			Layer.provide([
				discovery,
				DeveloperLayers.layer({
					...(publicNetwork === undefined ? {} : { publicNetwork }),
				}).pipe(
					Layer.provide(Governance.layer()),
					Layer.provide(IndexWorkRepository.layer),
					Layer.provide(Secrets.layer(Redacted.make("11".repeat(32)))),
					Layer.provide(discovery),
					Layer.provide(IndexRepository.layer),
				),
				Layer.mergeAll(
					AppExperience.layer.pipe(Layer.provideMerge(Lifecycle.layer)),
					Lifecycle.layer,
					Authorizations.layer(publicOrigin),
					Operations.layer,
					Views.layer.pipe(
						Layer.provide(
							Layer.succeed(Backend, { get: unused, forCaller: unused }),
						),
					),
				).pipe(
					Layer.provideMerge(Invocations.layer),
					Layer.provide(ActionPolicy.layer()),
					Layer.provideMerge(Connections.layer),
					Layer.provideMerge(Capabilities.layer),
					Layer.provide(AppHost.layer),
					Layer.provide(discovery),
					Layer.provide(CatalogDiscovery.layerRules),
					Layer.provide(Probe.layer),
					Layer.provide(Governance.layer()),
					Layer.provide(AppHost.layerNetwork),
					Layer.provideMerge(AppConnections.layerConnectionScopes),
					Layer.provide(ConnectionLocks.layer),
					Layer.provide(NodeCrypto.layer),
					Layer.provideMerge(
						Layer.mergeAll(
							InvocationRepository.layer,
							ViewRepository.layer,
							ProtocolStores.layer,
							AuthorizationRepository.layer,
						).pipe(
							Layer.provideMerge(AppRepository.layer),
							Layer.provide(Secrets.layer(Redacted.make("11".repeat(32)))),
						),
					),
				),
				PublicIndex.layer({ publicOrigin }).pipe(
					Layer.provide(Governance.layer()),
					Layer.provide(IndexRepository.layer),
				),
				TokensPostgres.layer,
				OrganizationFixture.layerEveryoneAdministrator,
				OrganizationFixture.layerNoAudit,
				Layer.succeed(Auth.Auth, auth),
				Layer.succeed(Backend, { get: unused, forCaller: unused }),
			]),
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
	await runtime.runPromise(Migration.initialize).catch(async (error) => {
		await runtime.dispose()
		await database.close()
		throw error
	})
	const address = await runtime.runPromise(
		Effect.map(HttpServer.HttpServer, (server) =>
			HttpServer.formatAddress(server.address),
		),
	)
	return {
		address,
		sql: (statement: string) =>
			runtime.runPromise(
				Effect.flatMap(PgClient.PgClient, (sql) => sql.unsafe(statement)),
			),
		get authCalls() {
			return authCalls
		},
		request: (payload: unknown, headers: Record<string, string> = {}) =>
			fetch(address + "/v1/apps/discover", {
				method: "POST",
				headers: { "content-type": "application/json", ...headers },
				body: JSON.stringify(payload),
			}),
		[Symbol.asyncDispose]: async () => {
			await runtime.dispose()
			await database.close()
		},
	}
}

test("the registered public App API checks ordinary AgentAuth before it discovers local services", async () => {
	await using publisher = await fixture()
	await using api = await startApi(publisher.layer)
	const payload = { input: publisher.origin + "/card?edition=team" }
	const session = { cookie: `${AuthApi.SessionCookie}=local-session` }
	const authenticated = { ...session, origin: publicOrigin }
	const denied: ReadonlyArray<readonly [Record<string, string>, number]> = [
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
			{ cookie: `${AuthApi.SessionCookie}=unavailable`, origin: publicOrigin },
			503,
		],
	]
	for (const [headers, status] of denied) {
		const response = await api.request(payload, headers)
		assert.equal(response.status, status)
		await response.text()
	}
	assert.equal(publisher.requests.length, 0)
	for (const invalid of [{}, { input: 123 }, { input: "" }]) {
		const response = await api.request(invalid, authenticated)
		assert.equal(response.status, 400)
		await response.text()
	}
	const malformed = await fetch(api.address + "/v1/apps/discover", {
		method: "POST",
		headers: { ...authenticated, "content-type": "application/json" },
		body: "{",
	})
	assert.equal(malformed.status, 400)
	await malformed.text()
	assert.equal(publisher.requests.length, 0)
	const response = await api.request(
		{ input: publisher.origin.slice(8) },
		{ ...session, origin: publicOrigin },
	)
	assert.equal(response.status, 200)
	const single = Schema.decodeUnknownSync(
		Schema.toCodecJson(AppDiscoveryResult),
	)(await response.json())
	assert.ok(single._tag === "Single")
	assert.equal(single.candidate.cardUrl, payload.input)
	assert.equal(
		single.candidate.endpoints[0]?.requirements[0]?.key,
		"header:X-Account",
	)
	assert.equal(
		single.candidate.sources[0]?.originalInput,
		publisher.origin.slice(8),
	)
	const spec = await (await fetch(api.address + "/openapi.json")).json()
	assert.deepEqual(spec.paths["/v1/apps/discover"].post.security, [
		{ token: [] },
		{ session: [] },
	])
	for (const status of ["200", "400", "401", "403", "422", "503"])
		assert.ok(spec.paths["/v1/apps/discover"].post.responses[status])
	assert.equal((await fetch(api.address + "/health")).status, 200)
	assert.equal(publisher.requests.includes("/mcp"), false)
})

test("shared public client decodes real HTTP discovery results and typed protocol failures", async () => {
	await using publisher = await fixture()
	await using api = await startApi(publisher.layer)
	await using client = ManagedRuntime.make(
		Client.layer({ baseUrl: api.address }).pipe(
			Layer.provide(
				Layer.succeed(FetchHttpClient.Fetch, (input, init) =>
					fetch(input, {
						...init,
						headers: {
							...Object.fromEntries(new Headers(init?.headers)),
							cookie: `${AuthApi.SessionCookie}=local-session`,
							origin: publicOrigin,
						},
					}),
				),
			),
		),
	)
	const discover = (input: string) =>
		Client.Client.use((client) =>
			client.api.apps.discoverApp({ payload: { input } }),
		)
	const multiple = await client.runPromise(
		discover(publisher.origin + "/catalog"),
	)
	assert.ok(multiple._tag === "Multiple")
	assert.equal(multiple.candidates.length, 2)
	assert.equal(multiple.issues[0]?.url, publisher.origin + "/invalid")
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
		const response = await api.request(
			{ input },
			{
				cookie: `${AuthApi.SessionCookie}=local-session`,
				origin: publicOrigin,
			},
		)
		assert.equal(response.status, 422)
		const failure = Schema.decodeUnknownSync(AppDiscoveryFailed)(
			await response.json(),
		)
		assert.equal(failure.reason, reason)
		const result = await client.runPromise(discover(input).pipe(Effect.result))
		assert.ok(Result.isFailure(result))
		assert.ok(Schema.is(AppDiscoveryFailed)(result.failure))
		assert.equal(result.failure.reason, reason)
	}
	await using publicApi = await startApi(AppDiscovery.layerPublic)
	const rejected = await publicApi.request(
		{ input: publisher.origin + "/card?edition=team" },
		{ cookie: `${AuthApi.SessionCookie}=local-session`, origin: publicOrigin },
	)
	assert.equal(rejected.status, 422)
	assert.equal(
		Schema.decodeUnknownSync(AppDiscoveryFailed)(await rejected.json()).reason,
		"BlockedTarget",
	)
})

test("anonymous developer inspection uses its own HTTPS evidence and does not change connections or the Index", async () => {
	await using publisher = await fixture()
	await using api = await startApi(publisher.layer, publisher.publicNetwork)
	const headers = {
		cookie: `${AuthApi.SessionCookie}=local-session`,
		origin: publicOrigin,
	}
	const inventory = await (
		await fetch(api.address + "/v1/connections", { headers })
	).text()
	const index = await (await fetch(api.address + "/v1/app-index/apps")).text()
	const inspect = async (input: string) => {
		const response = await fetch(api.address + "/v1/developer/inspect", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ input }),
		})
		assert.equal(response.status, 200, await response.clone().text())
		return Schema.decodeUnknownSync(
			Schema.toCodecJson(DeveloperApi.InspectionReport),
		)(await response.json())
	}
	const authCalls = api.authCalls.length
	const single = await inspect(publisher.origin + "/card?edition=team")
	assert.equal(single.apps[0]?.eligibility._tag, "Eligible")
	assert.ok(
		single.stages.some(
			(stage) => stage.name === "Eligibility" && stage.status === "Passed",
		),
	)
	await api.sql(
		"ALTER TABLE openbot_app_index_entries RENAME TO unavailable_index_entries",
	)
	try {
		const unknown = await inspect(publisher.origin + "/card?edition=team")
		assert.equal(unknown.apps[0]?.eligibility._tag, "Eligible")
		assert.equal(unknown.apps[0]?.stored._tag, "Unknown")
	} finally {
		await api.sql(
			"ALTER TABLE unavailable_index_entries RENAME TO openbot_app_index_entries",
		)
	}

	const multiple = await inspect(publisher.origin + "/catalog")
	assert.equal(multiple.apps.length, 2)
	assert.ok(multiple.issues.some((issue) => issue.code === "InvalidCandidate"))
	for (const path of ["/empty", "/none", "/malformed", "/redirect"]) {
		const report = await inspect(publisher.origin + path)
		assert.equal(report.apps.length, 0)
		assert.ok(report.issues.length > 0)
		assert.ok(report.stages.some((stage) => stage.status === "NotChecked"))
	}
	assert.equal(api.authCalls.length, authCalls)
	const count = publisher.requests.length
	const invalid = await fetch(api.address + "/v1/developer/inspect", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ input: "http://insecure.example/card" }),
	})
	assert.equal(invalid.status, 400)
	assert.equal(publisher.requests.length, count)
	assert.equal(publisher.requests.includes("/mcp"), false)
	assert.equal(
		await (await fetch(api.address + "/v1/connections", { headers })).text(),
		inventory,
	)
	assert.equal(
		await (await fetch(api.address + "/v1/app-index/apps")).text(),
		index,
	)
})
