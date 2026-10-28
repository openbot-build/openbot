import { Authorizer, Policy } from "@nmnmcc/ability"
import { assert, layer } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Authorization, Execution, TokenId } from "@openbot-build/domain"
import { Effect, Layer, Redacted, Ref, String as Str } from "effect"
import { SqlClient } from "effect/sql"
import { AuthorizationCommands } from "../src/apps/AuthorizationCommands.ts"
import { Connections } from "../src/apps/Connections.ts"
import * as ResetCommands from "../src/apps/ResetCommands.ts"
import { ownerKey } from "../src/apps/StoredConnections.ts"
import * as Database from "../src/database/DatabasePostgres.ts"
import * as Store from "../src/execution/Store.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import * as Policies from "./Policies.ts"
import * as Postgres from "./PostgresTest.ts"

const database = Layer.effectDiscard(Database.migrate).pipe(
	Layer.provideMerge(
		Layer.unwrap(
			Effect.map(Postgres.start, (db) =>
				Database.layer({ databaseUrl: Redacted.make(db.url) }),
			),
		),
	),
)
const services = Store.layer.pipe(
	Layer.provide(Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11")))),
	Layer.provideMerge(database),
	Layer.provideMerge(NodeServices.layer),
)

layer(services, { excludeTestServices: true })((it) => {
	it.effect(
		"an empty reset checks current rights before each read or write",
		() =>
			Effect.gen(function* () {
				const rights = yield* Ref.make<"read" | "write" | "all" | "none">(
					"read",
				)
				const policy = Authorizer.layer(Authorization.Auth, {
					policy: () =>
						Ref.get(rights).pipe(
							Effect.map((current) =>
								Policy.define(Authorization.OpenBot)(function* (_) {
									if (current === "read" || current === "all")
										yield* _.allow(
											"read",
											Authorization.Connection,
											Policies.own,
										)
									if (current === "write" || current === "all")
										yield* _.allow(
											"write",
											Authorization.Connection,
											Policies.own,
										)
								}),
							),
						),
				})
				const commands = ResetCommands.layer.pipe(
					Layer.provide(policy),
					// There are no connections. Per-connection checks must not replace the scope check.
					Layer.provide(Layer.mock(AuthorizationCommands, {})),
					Layer.provide(
						Layer.mock(Connections, { listConnections: Effect.succeed([]) }),
					),
				)
				yield* Effect.gen(function* () {
					const reset = yield* ResetCommands.ResetCommands
					const sql = yield* SqlClient.SqlClient
					const store = yield* Store.Store
					const actor = {
						kind: "user_token",
						organizationId: "reset-org",
						userId: "reset-user",
						tokenId: TokenId.make("reset-token"),
					} as const
					const owner = ownerKey(actor)
					yield* sql`insert into openbot_app_drafts (owner, id, body)
					values (${owner}, '00000000-0000-4000-8000-000000000001', 'saved draft')`
					yield* sql`insert into openbot_app_secrets (owner, kind, id, connection_id, body)
					values (${owner}, 'app-view', 'kept-view', 'no-connection', 'saved view')`
					const counts = sql<{
						readonly connections: number
						readonly drafts: number
						readonly views: number
						readonly executions: number
					}>`select
					(select count(*)::integer from openbot_app_connections) as connections,
					(select count(*)::integer from openbot_app_drafts) as drafts,
					(select count(*)::integer from openbot_app_secrets where kind = 'app-view') as views,
					(select count(*)::integer from openbot_executions) as executions`
					const commandKey = Execution.CommandKey.make("empty-reset")
					const before = [
						{ connections: 0, drafts: 1, views: 1, executions: 0 },
					]
					assert.deepStrictEqual(yield* counts, before)
					assert.equal(
						(yield* reset.start(actor, commandKey).pipe(Effect.flip))._tag,
						"ExecutionForbidden",
					)
					assert.deepStrictEqual(yield* counts, before)

					// Write access is enough to start a reset. It does not give read access.
					yield* Ref.set(rights, "write")
					const receipt = yield* reset.start(actor, commandKey)
					const key = { namespace: owner, id: receipt.executionId }
					assert.deepStrictEqual(yield* counts, [
						{ connections: 0, drafts: 0, views: 0, executions: 1 },
					])
					yield* reset.authorize(key, actor, "advance")
					assert.equal(
						(yield* reset.get(actor, receipt.executionId).pipe(Effect.flip))
							._tag,
						"ExecutionForbidden",
					)
					yield* Ref.set(rights, "all")
					assert.deepStrictEqual(
						(yield* reset.get(actor, receipt.executionId)).connections,
						[],
					)
					assert.equal(
						(yield* reset.start(actor, commandKey)).executionId,
						receipt.executionId,
					)
					const saved = yield* store.get(key)

					yield* Ref.set(rights, "none")
					assert.equal(
						(yield* reset.get(actor, receipt.executionId).pipe(Effect.flip))
							._tag,
						"ExecutionForbidden",
					)
					assert.equal(
						(yield* reset.start(actor, commandKey).pipe(Effect.flip))._tag,
						"ExecutionForbidden",
					)
					for (const mode of ["replay", "advance"] as const)
						assert.equal(
							(yield* reset.authorize(key, actor, mode).pipe(Effect.flip))._tag,
							"ExecutionForbidden",
						)
					assert.deepStrictEqual(yield* store.get(key), saved)
					assert.deepStrictEqual(yield* counts, [
						{ connections: 0, drafts: 0, views: 0, executions: 1 },
					])
				}).pipe(Effect.provide(commands))
			}),
	)
})
