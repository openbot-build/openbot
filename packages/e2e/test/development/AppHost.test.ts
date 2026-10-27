import { assert, layer } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Client } from "@openbot-build/protocol"
import {
	Array as Arr,
	Effect,
	Layer,
	Match,
	Redacted,
	String as Str,
} from "effect"
import {
	AppHost,
	DatabasePostgres as Database,
	HostTools,
	OpenBot,
	Server,
} from "@openbot-build/openbot"
import * as Development from "@openbot-build/openbot/Development"
import {
	DevelopmentTesting,
	PostgresTest as Postgres,
} from "@openbot-build/openbot/testing"
import { FetchHttpClient } from "effect/http"

layer(Layer.merge(NodeServices.layer, FetchHttpClient.layer), {
	excludeTestServices: true,
})((it) => {
	it.effect(
		"the development host serves a saved, owner-bound App service through the real MCP client",
		() =>
			Effect.gen(function* () {
				const database = yield* Postgres.start
				const configuration = {
					host: "127.0.0.1",
					port: 0,
					databaseUrl: Redacted.make(database.url),
					clusterSecret: Redacted.make(
						"test-cluster-secret-with-at-least-32-characters",
					),
					secretKeys: Redacted.make("test:" + Str.repeat(32)("11")),
					auth: {
						mode: "development" as const,
						publicOrigin: "https://localhost:8443",
						secret: Redacted.make(
							"AppHostDevelopmentSecretMustRemainStable123456",
						),
					},
				}
				yield* Database.migrate.pipe(
					Effect.provide(
						Database.layer(configuration).pipe(
							Layer.provide(NodeServices.layer),
						),
					),
				)
				const policy = Client.InvocationPolicy.of({ check: () => Effect.void })
				// Each server start builds its layer again, so nothing stays in memory.
				yield* Effect.gen(function* () {
					const factory = yield* AppHost.AppHost
					const alice = factory.bind("alice", policy)
					const bob = factory.bind("bob", policy)
					const discovery = yield* alice.discover(
						"https://app.development.test/card.json",
					)
					const candidate = Match.value(discovery).pipe(
						Match.tag("Single", ({ candidate }) => candidate),
						Match.tag("Multiple", ({ candidates }) => candidates[0]),
						Match.exhaustive,
					)
					assert.ok(candidate)
					const added = yield* alice.add({
						key: { owner: "alice", connectionId: "app" },
						candidate,
						remoteIndex: 0,
						values: {},
						confirmed: true,
						requiresAuthorization: true,
					})
					assert.strictEqual(added.connection.authorization._tag, "Unprotected")
					assert.strictEqual((yield* bob.listConnections).length, 0)
					assert.strictEqual(
						(yield* Effect.flip(
							bob.getConnection({ owner: "alice", connectionId: "app" }),
						)).reason,
						"Missing",
					)
					yield* Effect.scoped(
						Effect.gen(function* () {
							const client = yield* alice.open({
								key: { owner: "alice", connectionId: "app" },
								clientInfo: { name: "OpenBot test", version: "1.0.0" },
							})
							assert.strictEqual((yield* client.listTools()).tools.length, 2)
							assert.deepStrictEqual(
								Arr.map(
									(yield* client.listTools({ source: "model" })).tools,
									(tool) => tool.name,
								),
								["read_document"],
							)
						}),
					)
				}).pipe(
					Effect.provide(Development.layer(configuration), { local: true }),
				)
				assert.deepStrictEqual(
					yield* DevelopmentTesting.searchPublicApps.pipe(
						Effect.provide(
							Server.layerFixed(configuration).pipe(
								Layer.provide(
									Layer.merge(OpenBot.layerOutside, HostTools.none),
								),
								Layer.provideMerge(OpenBot.layerShared(configuration)),
							),
							{ local: true },
						),
					),
					{ apps: [], issues: [], nextCursor: null },
				)
				yield* Effect.gen(function* () {
					const app = (yield* AppHost.AppHost).bind("alice", policy)
					assert.strictEqual((yield* app.listConnections).length, 1)
				}).pipe(
					Effect.provide(Development.layer(configuration), { local: true }),
				)
			}),
	)
})
