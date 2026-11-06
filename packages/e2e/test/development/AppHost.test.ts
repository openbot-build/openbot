import * as TestDatabase from "@openbot-build/server-database/Testing"
import { assert, layer } from "@effect/vitest"
import { NodeCrypto, NodeServices } from "@effect/platform-node"
import { Client } from "@openbot-build/protocol"
import {
	Array as Arr,
	Effect,
	Layer,
	Match,
	Redacted,
	String as Str,
} from "effect"
import { Host } from "@openbot-build/openbot"
import * as AppHost from "@openbot-build/plugin-apps/AppHost"
import { PgClient } from "@effect/sql-pg"
import * as Migrations from "@openbot-build/server-database/Migrations"
import * as Development from "@openbot-build/server-development/Development"
import { DevelopmentTesting, TestHost } from "@openbot-build/server-testing"
import { FetchHttpClient } from "effect/http"

layer(
	Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, FetchHttpClient.layer),
	{
		excludeTestServices: true,
	},
)((it) => {
	it.effect(
		"the development host serves a saved, owner-bound App service through the real MCP client",
		() =>
			Effect.gen(function* () {
				const database = yield* TestDatabase.start
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
				yield* Migrations.migrate.pipe(
					Effect.provide(
						PgClient.layer({ url: configuration.databaseUrl }).pipe(
							Layer.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
						),
					),
				)
				const policy = Client.InvocationPolicy.of({ check: () => Effect.void })
				/** Starts the development server with the App services of the test. */
				const development = TestHost.startWith(
					DevelopmentTesting.appServices,
					(probe) => Development.layer({ ...configuration, ...probe }),
				)
				// Each server start builds its layer again, so nothing stays in memory.
				yield* Effect.scoped(
					Effect.flatMap(development, (onServer) =>
						onServer(
							Effect.gen(function* () {
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
								assert.strictEqual(
									added.connection.authorization._tag,
									"Unprotected",
								)
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
										assert.strictEqual(
											(yield* client.listTools()).tools.length,
											2,
										)
										assert.deepStrictEqual(
											Arr.map(
												(yield* client.listTools({ source: "model" })).tools,
												(tool) => tool.name,
											),
											["read_document"],
										)
									}),
								)
							}),
						),
					),
				)
				// A host without development sign-in reads the public Index, not the
				// development one.
				const publicApps = yield* Effect.scoped(
					Effect.flatMap(
						TestHost.startWith(DevelopmentTesting.appServices, (probe) =>
							Host.layer({
								...configuration,
								auth: {
									mode: "oidc" as const,
									publicOrigin: "https://localhost:8443",
									issuer: "https://id.example.com",
									clientId: "app-host-test",
									clientSecret: Redacted.make("fixture"),
									secret: Redacted.make(
										"AppHostDevelopmentSecretMustRemainStable123456",
									),
								},
								...probe,
							}),
						),
						(onServer) => onServer(DevelopmentTesting.searchPublicApps),
					),
				)
				assert.deepStrictEqual(publicApps, {
					apps: [],
					issues: [],
					nextCursor: null,
				})
				yield* Effect.scoped(
					Effect.flatMap(development, (onServer) =>
						onServer(
							Effect.gen(function* () {
								const app = (yield* AppHost.AppHost).bind("alice", policy)
								assert.strictEqual((yield* app.listConnections).length, 1)
							}),
						),
					),
				)
			}),
	)
})
