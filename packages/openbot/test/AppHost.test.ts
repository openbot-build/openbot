// @effect-diagnostics strictEffectProvide:off
import { assert, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Client } from "@openbot-build/protocol"
import { Effect, Layer, Match, Redacted } from "effect"
import { AppHost } from "../src/apps/AppHost.ts"
import * as Development from "../dist/Development.js"
import * as Database from "../src/database/DatabasePostgres.ts"
import * as Postgres from "./PostgresTest.ts"
import * as Server from "../dist/app/Server.js"
import { PublicIndex } from "../src/apps/Index.ts"

it.live(
	"the development host serves a saved, owner-bound App service through the real MCP client",
	() =>
		Effect.gen(function* () {
			const database = yield* Effect.acquireRelease(
				Effect.promise(() => Postgres.start()),
				(database) => Effect.promise(() => database.close()),
			)
			const configuration = {
				host: "127.0.0.1",
				port: 0,
				databaseUrl: Redacted.make(database.url),
				secretKeys: Redacted.make("test:" + "11".repeat(32)),
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
					Database.layer(configuration).pipe(Layer.provide(NodeServices.layer)),
				),
			)
			const policy = Client.InvocationPolicy.of({ check: () => Effect.void })
			// Each server start builds its layer again, so nothing stays in memory.
			yield* Effect.gen(function* () {
				const factory = yield* AppHost
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
							(yield* client.listTools({ source: "model" })).tools.map(
								(tool) => tool.name,
							),
							["read_document"],
						)
					}),
				)
			}).pipe(Effect.provide(Development.layer(configuration), { local: true }))
			assert.deepStrictEqual(
				yield* Effect.flatMap(PublicIndex, (index) => index.search({})).pipe(
					Effect.provide(Server.layerFixed(configuration), { local: true }),
				),
				{ apps: [], issues: [], nextCursor: null },
			)
			yield* Effect.gen(function* () {
				const app = (yield* AppHost).bind("alice", policy)
				assert.strictEqual((yield* app.listConnections).length, 1)
			}).pipe(Effect.provide(Development.layer(configuration), { local: true }))
		}),
)
