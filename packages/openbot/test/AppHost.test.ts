// @effect-diagnostics strictEffectProvide:off
import assert from "node:assert/strict"
import { test } from "node:test"
import { NodeServices } from "@effect/platform-node"
import { Client } from "@openbot-build/protocol"
import { Effect, Layer, ManagedRuntime, Match, Redacted } from "effect"
import { AppHost } from "../src/apps/AppHost.ts"
import * as Development from "../dist/Development.js"
import * as Database from "../src/database/DatabasePostgres.ts"
import * as Postgres from "./PostgresTest.ts"
import * as Server from "../dist/app/Server.js"
import { PublicIndex } from "../src/apps/Index.ts"

test("the development host serves a saved, owner-bound app-host App service through the real MCP client", async () => {
	const database = await Postgres.start()
	const configuration = {
		host: "127.0.0.1",
		port: 0,
		databaseUrl: Redacted.make(database.url),
		appEncryptionKey: Redacted.make("11".repeat(32)),
		auth: {
			mode: "development" as const,
			publicOrigin: "https://localhost:8443",
			secret: Redacted.make("AppHostDevelopmentSecretMustRemainStable123456"),
		},
	}
	const migration = ManagedRuntime.make(
		Database.layer(configuration).pipe(Layer.provide(NodeServices.layer)),
	)
	await migration.runPromise(Database.migrate)
	let runtime = ManagedRuntime.make(Development.layer(configuration))
	const policy = Client.InvocationPolicy.of({ check: () => Effect.void })
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
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
				assert.equal(added.connection.authorization._tag, "Unprotected")
				assert.equal((yield* bob.listConnections).length, 0)
				assert.equal(
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
						assert.equal((yield* client.listTools()).tools.length, 2)
						assert.deepEqual(
							(yield* client.listTools({ source: "model" })).tools.map(
								(tool) => tool.name,
							),
							["read_document"],
						)
					}),
				)
			}),
		)
		await runtime.dispose()
		const production = ManagedRuntime.make(Server.layer(configuration))
		try {
			assert.deepEqual(
				await production.runPromise(
					Effect.flatMap(PublicIndex, (index) => index.search({})),
				),
				{ apps: [], issues: [], nextCursor: null },
			)
		} finally {
			await production.dispose()
		}
		runtime = ManagedRuntime.make(Development.layer(configuration))
		await runtime.runPromise(
			Effect.gen(function* () {
				const app = (yield* AppHost).bind("alice", policy)
				assert.equal((yield* app.listConnections).length, 1)
			}),
		)
	} finally {
		await runtime.dispose()
		await migration.dispose()
		await database.close()
	}
})
