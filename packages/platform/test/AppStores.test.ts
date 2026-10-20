// @effect-diagnostics strictEffectProvide:off
import assert from "node:assert/strict"
import { test } from "node:test"
import { NodeServices } from "@effect/platform-node"
import { Authorization, Store } from "@openbot-build/protocol"
import { Effect, Layer, ManagedRuntime, Redacted, Result } from "effect"
import { SqlClient } from "effect/sql"
import * as ProtocolStores from "../src/apps/ProtocolStores.ts"
import * as Repository from "../src/apps/RepositoryPostgres.ts"
import * as Secrets from "../src/apps/Secrets.ts"
import * as Database from "../src/database/DatabasePostgres.ts"
import * as Postgres from "./PostgresTest.ts"

test("encrypted credentials and one-time PKCE flows survive a restart and check their full owner binding", async () => {
	const database = await Postgres.start()
	const layers = (key = "11".repeat(32)) =>
		ProtocolStores.layer.pipe(
			Layer.provideMerge(Repository.layer),
			Layer.provide(Secrets.layer(Redacted.make(key))),
			Layer.provideMerge(
				Database.layer({ databaseUrl: Redacted.make(database.url) }),
			),
			Layer.provide(NodeServices.layer),
		)
	let runtime = ManagedRuntime.make(layers())
	try {
		const reference = await runtime.runPromise(
			Effect.gen(function* () {
				yield* Database.migrate
				const stores = (yield* ProtocolStores.ProtocolStores).bind("alice")
				const binding = yield* Store.CredentialBinding.decode({
					owner: "alice",
					connectionId: "documents",
					resource: "https://example.test/mcp",
					issuer: "https://auth.example.test",
				})
				const reference = yield* stores.credentials.put(
					yield* Store.Credential.decode({
						binding,
						accessToken: Redacted.make("private-access-token"),
						refreshToken: Redacted.make("private-refresh-token"),
						scopes: ["documents"],
					}),
				)
				yield* stores.flows.save(
					yield* Authorization.Flow.decode({
						flowId: "flow",
						binding,
						clientId: "https://platform.test/client",
						redirectUri: "https://platform.test/callback",
						scopes: ["documents"],
						verifier: Redacted.make("private-pkce-verifier"),
						expiresAt: Date.now() + 60000,
						metadata: {
							issuer: "https://auth.example.test",
							authorization_endpoint: "https://auth.example.test/authorize",
							token_endpoint: "https://auth.example.test/token",
							code_challenge_methods_supported: ["S256"],
							response_types_supported: ["code"],
						},
					}),
				)
				const sql = yield* SqlClient.SqlClient
				const rows = yield* sql<{
					readonly body: string
				}>`SELECT body FROM openbot_app_secrets`
				assert.equal(rows.length, 2)
				assert.equal(
					rows.some((row) => row.body.includes("private-")),
					false,
				)
				return reference
			}),
		)
		await runtime.dispose()
		runtime = ManagedRuntime.make(layers())
		await runtime.runPromise(
			Effect.gen(function* () {
				const service = yield* ProtocolStores.ProtocolStores
				const alice = service.bind("alice")
				const bob = service.bind("bob")
				const binding = yield* Store.CredentialBinding.decode({
					owner: "alice",
					connectionId: "documents",
					resource: "https://example.test/mcp",
					issuer: "https://auth.example.test",
				})
				assert.equal(
					Redacted.value(
						(yield* alice.credentials.get({ binding, reference })).accessToken,
					),
					"private-access-token",
				)
				assert.equal(
					(yield* Effect.flip(bob.credentials.get({ binding, reference })))
						.reason,
					"Missing",
				)
				assert.equal(
					(yield* Effect.flip(
						alice.credentials.get({
							binding: { ...binding, resource: "https://other.test/mcp" },
							reference,
						}),
					)).reason,
					"Missing",
				)
				const request = {
					key: { owner: "alice", connectionId: "documents" },
					flowId: "flow",
				}
				assert.equal(
					Redacted.value((yield* alice.flows.get(request)).verifier),
					"private-pkce-verifier",
				)
				const claims = yield* Effect.all(
					[
						alice.flows.consume(request).pipe(Effect.result),
						alice.flows.consume(request).pipe(Effect.result),
					],
					{ concurrency: 2 },
				)
				assert.equal(claims.filter(Result.isSuccess).length, 1)
				assert.equal(claims.filter(Result.isFailure).length, 1)
				assert.equal(
					(yield* Effect.flip(alice.flows.get(request)))._tag,
					"AuthorizationError",
				)
				yield* alice.credentials.deleteConnection(request.key)
				assert.equal(
					(yield* Effect.flip(alice.credentials.get({ binding, reference })))
						.reason,
					"Missing",
				)
			}),
		)
		const invalid = ManagedRuntime.make(layers("invalid"))
		try {
			assert.equal(
				(await invalid.runPromiseExit(ProtocolStores.ProtocolStores))._tag,
				"Failure",
			)
		} finally {
			await invalid.dispose()
		}
	} finally {
		await runtime.dispose()
		await database.close()
	}
})
