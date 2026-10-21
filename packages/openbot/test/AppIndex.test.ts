// @effect-diagnostics strictEffectProvide:off
import assert from "node:assert/strict"
import { test } from "node:test"
import { AppIndexApi as Api, OpenBotApi } from "@openbot-build/api"
import { Document, Index } from "@openbot-build/protocol"
import { Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect"
import { NodeServices } from "@effect/platform-node"
import { OpenApi } from "effect/http-api"
import * as Governance from "../src/apps/Governance.ts"
import * as PublicIndex from "../src/apps/Index.ts"
import { IndexRepository } from "../src/apps/IndexRepository.ts"
import * as Repository from "../src/apps/IndexRepositoryPostgres.ts"
import * as Database from "../src/database/DatabasePostgres.ts"
import * as Migration from "../src/database/Migrations.ts"
import * as Server from "../dist/app/Server.js"
import { HttpServer } from "effect/http"
import * as PostgresTest from "./PostgresTest.ts"
import * as Client from "@openbot-build/client"

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

test("public Index contract declares anonymous reads and typed page failures", () => {
	const document = OpenApi.fromApi(OpenBotApi)
	const operation = document.paths["/v1/app-index/apps"]?.get
	assert.ok(operation)
	assert.ok(operation.security === undefined || operation.security.length === 0)
	assert.ok(operation.responses["400"])
	assert.ok(operation.responses["503"])
	assert.ok(document.paths["/v1/apps/discover"]?.post?.security?.length)
})

test("the stored public Index searches, merges sources and pages results without leaking connection data", async () => {
	const database = await PostgresTest.start()
	const db = Database.layer({ databaseUrl: Redacted.make(database.url) }).pipe(
		Layer.provide(NodeServices.layer),
	)
	const repository = Repository.layer.pipe(Layer.provideMerge(db))
	const second = await Effect.runPromise(entry("second"))
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
	const runtime = ManagedRuntime.make(
		PublicIndex.layer({
			publicOrigin: "https://openbot.test",
			providers: sources,
		}).pipe(Layer.provideMerge(repository), Layer.provide(Governance.layer())),
	)
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				yield* Migration.initialize
				const index = yield* PublicIndex.PublicIndex
				const store = yield* IndexRepository
				assert.deepEqual((yield* index.search({ source: "openbot" })).apps, [])
				yield* store.upsert(yield* entry("first"))
				yield* store.upsert(second)
				const page = yield* index.search({ limit: "1" })
				assert.equal(page.apps.length, 1)
				assert.equal(page.issues[0]?.source, "offline")
				assert.ok(page.nextCursor)
				const next = yield* index.search({
					limit: "1",
					cursor: page.nextCursor,
				})
				assert.equal(next.apps[0]?.entry.cardUrl, second.cardUrl)
				assert.deepEqual(
					next.apps[0]?.sources.map((source) => source.id),
					["openbot", "second"],
				)
				assert.equal(next.nextCursor, null)
				assert.equal((yield* index.search({ query: "project" })).apps.length, 2)
				assert.equal(
					(yield* index.search({
						query: "example.test",
					})).apps[0]?.matches.includes("publisher"),
					true,
				)
				assert.equal(
					(yield* Effect.flip(
						index.search({ cursor: page.nextCursor, query: "other" }),
					))._tag,
					"IndexInputInvalid",
				)
				assert.equal(
					(yield* Effect.flip(index.search({ source: "offline" })))._tag,
					"IndexUnavailable",
				)
				assert.equal(
					(yield* Effect.flip(index.get("https://example.test/missing")))._tag,
					"IndexNotFound",
				)
				assert.equal((yield* index.get(second.cardUrl)).sources.length, 2)
			}),
		)
		await runtime.dispose()
		const restarted = ManagedRuntime.make(repository)
		try {
			assert.equal(
				(
					await restarted.runPromise(
						Effect.flatMap(IndexRepository, (store) => store.list),
					)
				).length,
				2,
			)
		} finally {
			await restarted.dispose()
		}
		const configuration = {
			host: "127.0.0.1",
			port: 0,
			databaseUrl: Redacted.make(database.url),
			appEncryptionKey: Redacted.make(
				"1111111111111111111111111111111111111111111111111111111111111111",
			),
			auth: {
				publicOrigin: "https://openbot.test",
				issuer: "https://id.example.com",
				clientId: "index-test",
				clientSecret: Redacted.make("fixture"),
				secret: Redacted.make("StableAppIndexTestSecretLongEnough123456789"),
			},
		}
		const server = ManagedRuntime.make(Server.layer(configuration))
		try {
			const address = await server.runPromise(
				Effect.map(HttpServer.HttpServer, (http) =>
					HttpServer.formatAddress(http.address),
				),
			)
			const anonymous = await fetch(`${address}/v1/app-index/apps`)
			assert.equal(anonymous.status, 200)
			const publicPage = Schema.decodeUnknownSync(Api.Page)(
				await anonymous.json(),
			)
			assert.equal(publicPage.apps.length, 2)
			assert.equal(
				(await fetch(`${address}/v1/app-index/apps?cursor=invalid`)).status,
				400,
			)
			assert.equal(
				(await fetch(`${address}/v1/app-index/apps?source=missing`)).status,
				404,
			)
			const cookieRead = await fetch(`${address}/v1/app-index/apps`, {
				headers: { cookie: "__Host-openbot-session=not-a-real-user" },
			})
			assert.deepEqual(await cookieRead.json(), publicPage)
			assert.equal((await fetch(`${address}/v1/connections`)).status, 401)
			const client = ManagedRuntime.make(Client.layer({ baseUrl: address }))
			try {
				assert.equal(
					(
						await client.runPromise(
							Effect.flatMap(Client.Client, (api) =>
								api.api.appIndex.searchApps({ query: { query: "project" } }),
							),
						)
					).apps.length,
					2,
				)
			} finally {
				await client.dispose()
			}
		} finally {
			await server.dispose()
		}
	} finally {
		await runtime.dispose()
		await database.close()
	}
})
