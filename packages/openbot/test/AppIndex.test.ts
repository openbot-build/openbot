import { assert, layer } from "@effect/vitest"
import { AppIndexApi as Api, OpenBotApi } from "@openbot-build/api"
import { Document, Index } from "@openbot-build/protocol"
import { Array as Arr, Context, Effect, Layer, Redacted, Schema } from "effect"
import { NodeServices } from "@effect/platform-node"
import { OpenApi } from "effect/http-api"
import * as Governance from "../src/apps/Governance.ts"
import * as OrganizationFixture from "./OrganizationFixture.ts"
import * as PublicIndex from "../src/apps/Index.ts"
import * as IndexStore from "../src/apps/IndexStore.ts"
import { appIndexEntries } from "../src/database/Schema.ts"
import * as Database from "../src/database/DatabasePostgres.ts"
import * as Migration from "../src/database/Migrations.ts"
import * as Server from "../dist/app/Server.js"
import { HostTools, OpenBot } from "@openbot-build/openbot"
import { FetchHttpClient, HttpClient, HttpServer } from "effect/http"
import * as PostgresTest from "./PostgresTest.ts"
import * as Client from "@openbot-build/client"
import * as Db from "../src/database/Database.ts"

/** The Node services for the test database, and an HTTP client to call the server. */
const platform = Layer.merge(NodeServices.layer, FetchHttpClient.layer)

const entry = (path: string, name = "example.test/documents") =>
	Index.Entry.decode({
		cardUrl: `https://example.test/${path}`,
		card: {
			$schema: Document.cardSchemaUrl,
			name,
			version: "1.0.0",
			description: "Searchable project documents",
			remotes: [
				{
					type: "streamable-http",
					url: "https://example.test/mcp",
					supportedProtocolVersions: [Document.protocolVersion],
				},
			],
		},
		evidence: [
			{
				publisherUrl: "https://example.test/",
				catalogUrl: "https://example.test/.well-known/ai-catalog.json",
				cardUrl: `https://example.test/${path}`,
				association: "CardOrigin",
			},
		],
		checkedAt: 1000,
		validators: {},
	})

layer(platform, { excludeTestServices: true })((it) => {
	it.effect(
		"public Index contract declares anonymous reads and typed page failures",
		() =>
			Effect.sync(() => {
				const document = OpenApi.fromApi(OpenBotApi)
				const operation = document.paths["/v1/app-index/apps"]?.get
				assert.ok(operation)
				assert.ok(
					operation.security === undefined || operation.security.length === 0,
				)
				assert.ok(operation.responses["400"])
				assert.ok(operation.responses["503"])
				assert.ok(document.paths["/v1/apps/discover"]?.post?.security?.length)
			}),
	)

	it.effect(
		"the stored public Index searches, merges sources and pages results without leaking connection data",
		() =>
			Effect.gen(function* () {
				const database = yield* PostgresTest.start
				const db = Database.layer({
					databaseUrl: Redacted.make(database.url),
				}).pipe(Layer.provide(NodeServices.layer))
				const repository = IndexStore.layer.pipe(Layer.provideMerge(db))
				const second = yield* entry("second")
				const sources: ReadonlyArray<PublicIndex.SourceProvider> = [
					{
						source: {
							id: "second",
							name: "Second Index",
							url: "https://second.test/v1/app-index/apps",
							simulated: false,
						},
						entries: Effect.succeed([second]),
					},
					{
						source: {
							id: "offline",
							name: "Offline Index",
							url: "https://offline.test/v1/app-index/apps",
							simulated: false,
						},
						entries: Effect.fail(
							Api.IndexUnavailable.make({
								issues: [{ source: "offline", message: "Offline" }],
							}),
						),
					},
				]
				yield* Effect.gen(function* () {
					yield* Migration.initialize
					const index = yield* PublicIndex.PublicIndex
					const store = yield* Index.IndexStore
					assert.deepStrictEqual(
						(yield* index.search({ source: "openbot" })).apps,
						[],
					)
					yield* store.upsert(yield* entry("first"))
					yield* store.upsert(second)
					const page = yield* index.search({ limit: 1 })
					assert.strictEqual(page.apps.length, 1)
					assert.strictEqual(page.issues[0]?.source, "offline")
					assert.ok(page.nextCursor)
					const next = yield* index.search({
						limit: 1,
						cursor: page.nextCursor,
					})
					assert.strictEqual(next.apps[0]?.entry.cardUrl, second.cardUrl)
					assert.deepStrictEqual(
						Arr.map(next.apps[0]?.sources ?? [], (source) => source.id),
						["openbot", "second"],
					)
					assert.strictEqual(next.nextCursor, null)
					assert.strictEqual(
						(yield* index.search({ query: "project" })).apps.length,
						2,
					)
					assert.strictEqual(
						(yield* index.search({
							query: "example.test",
						})).apps[0]?.matches.includes("publisher"),
						true,
					)
					assert.strictEqual(
						(yield* Effect.flip(
							index.search({ cursor: page.nextCursor, query: "other" }),
						))._tag,
						"IndexInputInvalid",
					)
					assert.strictEqual(
						(yield* Effect.flip(index.search({ source: "offline" })))._tag,
						"IndexUnavailable",
					)
					assert.strictEqual(
						(yield* Effect.flip(index.get("https://example.test/missing")))
							._tag,
						"IndexNotFound",
					)
					assert.strictEqual(
						(yield* index.get(second.cardUrl)).sources.length,
						2,
					)
				}).pipe(
					Effect.provide(
						PublicIndex.layer({ providers: sources }).pipe(
							Layer.provideMerge(repository),
							Layer.provide(Governance.layer),
							Layer.provide(
								OrganizationFixture.layerSettings({
									publicOrigin: "https://openbot.test",
								}),
							),
						),
					),
				)
				// A new database pool still finds the stored entries.
				assert.strictEqual(
					(yield* Effect.flatMap(Db.make, (db) =>
						db.select().from(appIndexEntries),
					).pipe(Effect.provide(repository))).length,
					2,
				)
				const configuration = {
					host: "127.0.0.1",
					port: 0,
					databaseUrl: Redacted.make(database.url),
					secretKeys: Redacted.make(
						"test:" +
							"1111111111111111111111111111111111111111111111111111111111111111",
					),
					auth: {
						publicOrigin: "https://openbot.test",
						issuer: "https://id.example.com",
						clientId: "index-test",
						clientSecret: Redacted.make("fixture"),
						secret: Redacted.make(
							"StableAppIndexTestSecretLongEnough123456789",
						),
					},
				}
				const server = yield* Layer.build(
					Server.layerFixed(configuration).pipe(
						Layer.provide(Layer.merge(OpenBot.layerOutside, HostTools.none)),
						Layer.provideMerge(OpenBot.layerShared(configuration)),
					),
				)
				const address = HttpServer.formatAddress(
					Context.get(server, HttpServer.HttpServer).address,
				)
				const anonymous = yield* HttpClient.get(`${address}/v1/app-index/apps`)
				assert.strictEqual(anonymous.status, 200)
				const publicPage = yield* Effect.flatMap(
					anonymous.json,
					Schema.decodeUnknownEffect(Api.Page),
				)
				assert.strictEqual(publicPage.apps.length, 2)
				assert.strictEqual(
					(yield* HttpClient.get(`${address}/v1/app-index/apps?cursor=invalid`))
						.status,
					400,
				)
				assert.strictEqual(
					(yield* HttpClient.get(`${address}/v1/app-index/apps?source=missing`))
						.status,
					404,
				)
				const cookieRead = yield* HttpClient.get(
					`${address}/v1/app-index/apps`,
					{ headers: { cookie: "__Host-openbot-session=not-a-real-user" } },
				)
				assert.deepStrictEqual(yield* cookieRead.json, yield* anonymous.json)
				assert.strictEqual(
					(yield* HttpClient.get(`${address}/v1/connections`)).status,
					401,
				)
				assert.strictEqual(
					(yield* Effect.flatMap(Client.Client, (api) =>
						api.api.appIndex.searchApps({ query: { query: "project" } }),
					).pipe(Effect.provide(Client.layer({ baseUrl: address })))).apps
						.length,
					2,
				)
			}),
	)
})
