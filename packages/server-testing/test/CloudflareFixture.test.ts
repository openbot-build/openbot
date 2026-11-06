import * as TestDatabase from "@openbot-build/server-database/Testing"
import { assert, layer } from "@effect/vitest"
import { PgClient } from "@effect/sql-pg"
import { SqlClient } from "effect/sql"
import { NodeCrypto, NodeServices } from "@effect/platform-node"
import { Effect, Layer, Redacted, Result, String as Str } from "effect"
import { FetchHttpClient } from "effect/http"
import { browser } from "../src/DevelopmentLogin.ts"
import {
	origin,
	keepPrivate,
	environment,
	migrate,
	seedSession,
	start,
} from "../src/Cloudflare.ts"

// The database and servers use real time.
layer(
	Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, FetchHttpClient.layer),
	{
		excludeTestServices: true,
	},
)((it) => {
	it.effect("a failed private request keeps only scrubbed cause text", () =>
		Effect.gen(function* () {
			const key = "private-test-key"
			const endpoint = "https://private.example.com/account"
			const result = yield* keepPrivate(
				Effect.fail({
					_tag: "HttpClientError",
					request: { body: { apiKey: key }, url: endpoint },
				}),
				[key, endpoint],
			).pipe(Effect.result)
			assert.ok(Result.isFailure(result))
			assert.strictEqual(result.failure._tag, "PrivateCallFailed")
			assert.strictEqual(Str.includes(key)(result.failure.reason), false)
			assert.strictEqual(Str.includes(endpoint)(result.failure.reason), false)
			assert.match(result.failure.reason, /HttpClientError/)
			assert.notProperty(result.failure, "request")
			assert.notProperty(result.failure, "cause")
		}),
	)
	it.effect(
		"session setup leaves no index work for the production server",
		() =>
			Effect.gen(function* () {
				const database = yield* TestDatabase.start
				const env = environment(database.url)
				yield* migrate(env)
				const session = yield* seedSession(env)
				const address = yield* start(env)
				const cookie = browser(address, origin, session)
				assert.strictEqual((yield* cookie("/v1/chats", "GET")).status, 200)
				yield* Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient
					const rows = yield* sql<{
						readonly jobs: number
						readonly executions: number
						readonly failures: number
					}>`select
						(select count(*)::integer from openbot_app_index_jobs) as jobs,
						(select count(*)::integer from openbot_executions
							where resource_kind in ('IndexWatch', 'IndexCheck')) as executions,
						(select count(*)::integer from openbot_execution_failures) as failures`
					assert.deepStrictEqual(rows, [
						{ jobs: 0, executions: 0, failures: 0 },
					])
				}).pipe(
					Effect.provide(PgClient.layer({ url: Redacted.make(database.url) })),
				)
			}),
		{ timeout: 60000 },
	)
})
