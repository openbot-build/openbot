import { Authorizer, Policy } from "@nmnmcc/ability"
import { Document } from "@openbot-build/protocol"
import { Authorization, TokenId } from "@openbot-build/domain"
import { DeveloperAccess } from "../src/apps/DeveloperAccess.ts"
import * as DeveloperIndexing from "../src/apps/DeveloperIndexing.ts"
import * as Governance from "../src/apps/Governance.ts"
import * as OrganizationFixture from "./OrganizationFixture.ts"
import * as Observation from "../src/execution/Observation.ts"
import * as Db from "../src/database/Database.ts"
import { developerApps } from "../src/database/Schema.ts"
import { ownerKey } from "../src/apps/StoredConnections.ts"
import { assert, layer } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Execution } from "@openbot-build/domain"
import {
	Array as Arr,
	Effect,
	Layer,
	Option,
	Schema,
	Redacted,
	Ref,
	String as Str,
} from "effect"
import { SqlClient } from "effect/sql"
import * as Database from "../src/database/DatabasePostgres.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import * as Store from "../src/execution/Store.ts"
import * as ErrorRecords from "../src/errors/Records.ts"
import { IndexWork } from "../src/apps/IndexWork.ts"
import * as IndexCommandsFixture from "./IndexCommandsFixture.ts"
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
const services = IndexCommandsFixture.layer.pipe(
	Layer.provideMerge(Layer.merge(Store.layer, ErrorRecords.layer)),
	Layer.provide(Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11")))),
	Layer.provideMerge(database),
	Layer.provideMerge(NodeServices.layer),
)
layer(services, { excludeTestServices: true })((it) => {
	it.effect(
		"member requests keep their token and cancel without stopping a shared check",
		() =>
			Effect.gen(function* () {
				const revoked = yield* Ref.make(false)
				const policy = Authorizer.layer(Authorization.Auth, {
					policy: (actor) =>
						Ref.get(revoked).pipe(
							Effect.map((deny) =>
								Policy.define(Authorization.OpenBot)(function* (_) {
									yield* _.allow("*", "*")
									if (deny && actor.kind === "user_token")
										yield* _.deny("publish", Authorization.App)
								}),
							),
						),
				})
				const commands = DeveloperIndexing.layer.pipe(
					Layer.provide(policy),
					Layer.provide(
						Layer.mock(DeveloperAccess, {
							authorize: () => Effect.succeed([]),
						}),
					),
					Layer.provide(Observation.layer),
					Layer.provide(
						Governance.layer.pipe(
							Layer.provide(OrganizationFixture.layerDefaultSettings),
						),
					),
				)
				yield* Effect.gen(function* () {
					const indexing = yield* DeveloperIndexing.DeveloperIndexing
					const index = yield* IndexWork
					const store = yield* Store.Store
					const db = yield* Db.make
					const cardUrl = "https://example.test/member-request"
					yield* db.insert(developerApps).values({
						namespace: "public",
						cardUrl,
						nextCheckAt: 0,
						candidate: yield* Schema.encodeEffect(
							Schema.fromJsonString(Schema.Unknown),
						)({
							cardUrl,
							sources: [],
							endpoints: [],
							card: {
								$schema: Document.cardSchemaUrl,
								name: "example.test/app",
								version: "1.0.0",
								description: "Test App",
								remotes: [
									{
										type: "streamable-http",
										url: "https://example.test/mcp",
										supportedProtocolVersions: [Document.protocolVersion],
									},
								],
							},
						}),
					})
					const actor = {
						kind: "user_token",
						organizationId: "org",
						userId: "user",
						tokenId: TokenId.make("source-token"),
					} as const
					const first = yield* indexing.request(
						actor,
						cardUrl,
						Execution.CommandKey.make("index-one"),
					)
					assert.strictEqual(
						(yield* indexing.request(
							actor,
							cardUrl,
							Execution.CommandKey.make("index-one"),
						)).id,
						first.id,
					)
					const second = yield* indexing.request(
						actor,
						cardUrl,
						Execution.CommandKey.make("index-two"),
					)
					assert.notStrictEqual(first.executionId, second.executionId)
					assert.strictEqual(first.generation, second.generation)
					const key = { namespace: ownerKey(actor), id: first.executionId }
					const fence = yield* store.takeOver(key)
					assert.deepStrictEqual(
						(yield* store.loadMember(key)).identity.actor,
						actor,
					)
					const watch = (yield* index.request(cardUrl, [])).execution
					const before = yield* store.get(watch)
					yield* store.cancel(
						key,
						Execution.CommandKey.make("stop-index"),
						actor,
					)
					yield* store.finishCancellation(
						fence,
						(yield* store.loadMember(key)).cancelEpoch,
						() => Effect.succeed([]),
					)
					assert.strictEqual((yield* store.get(key)).status, "cancelled")
					assert.deepStrictEqual(yield* store.get(watch), before)
					const other = { namespace: key.namespace, id: second.executionId }
					yield* Ref.set(revoked, true)
					assert.strictEqual(
						(yield* indexing
							.authorize(other, actor, "advance")
							.pipe(Effect.flip))._tag,
						"ExecutionForbidden",
					)
					assert.strictEqual(
						(yield* indexing
							.authorize(
								other,
								{
									kind: "member",
									userId: actor.userId,
									organizationId: actor.organizationId,
								},
								"advance",
							)
							.pipe(Effect.flip))._tag,
						"ExecutionForbidden",
					)
					yield* Ref.set(revoked, false)
					const checker = yield* store.takeOver(watch)
					yield* index.begin(checker)
					yield* index.complete(checker, second.generation, {
						_tag: "Checked",
						result: { _tag: "Excluded", cardUrl, reason: "No publication" },
					})
					yield* indexing.work(yield* store.takeOver(other))
					assert.strictEqual((yield* store.get(other)).status, "completed")
				}).pipe(Effect.provide(commands))
			}),
	)

	it.effect(
		"concurrent Index requests share a check and a rollback leaves no work",
		() =>
			Effect.gen(function* () {
				const index = yield* IndexWork
				const store = yield* Store.Store
				const sql = yield* SqlClient.SqlClient
				const cardUrl = "https://example.test/coalesced"
				const requests = yield* Effect.all(
					Arr.makeBy(12, () => index.request(cardUrl, [])),
					{ concurrency: "unbounded" },
				)
				const first = requests[0]!
				assert.ok(
					Arr.every(
						requests,
						(value) =>
							value.job.generation === first.job.generation &&
							value.execution.id === first.execution.id,
					),
				)
				const fence = yield* store.takeOver(first.execution)
				yield* index.begin(fence)
				const result = {
					_tag: "Checked",
					result: { _tag: "Excluded", cardUrl, reason: "No publication" },
				} as const
				yield* index.complete(fence, first.job.generation, result)
				const before = yield* store.get(fence)
				yield* index.complete(fence, first.job.generation, result)
				assert.strictEqual((yield* store.get(fence)).sequence, before.sequence)
				const rolledBack = yield* Effect.flip(
					sql.withTransaction(
						index
							.request(cardUrl, [])
							.pipe(Effect.andThen(Effect.fail("rollback"))),
					),
				)
				assert.strictEqual(rolledBack, "rollback")
				assert.strictEqual((yield* store.get(fence)).sequence, before.sequence)
				assert.strictEqual(
					Option.getOrThrow(yield* index.job(cardUrl)).generation,
					first.job.generation,
				)
				const next = yield* index.request(cardUrl, [])
				assert.strictEqual(next.execution.id, first.execution.id)
				assert.notStrictEqual(next.job.generation, first.job.generation)
				assert.strictEqual(
					Option.getOrThrow(yield* index.job(cardUrl, first.job.generation))
						.check?._tag,
					"Excluded",
				)
				const absent = "https://example.test/rollback"
				yield* sql
					.withTransaction(
						index
							.request(absent, [])
							.pipe(Effect.andThen(Effect.fail("rollback"))),
					)
					.pipe(Effect.flip)
				assert.ok(Option.isNone(yield* index.job(absent)))
			}),
	)
	it.effect("a late Index result cannot change a new owner's check", () =>
		Effect.gen(function* () {
			const index = yield* IndexWork
			const store = yield* Store.Store
			const cardUrl = "https://example.test/takeover"
			const request = yield* index.request(cardUrl, [])
			const first = yield* store.takeOver(request.execution)
			const started = yield* index.begin(first)
			const second = yield* store.takeOver(request.execution)
			const resumed = yield* index.begin(second)
			assert.deepStrictEqual(resumed, started)
			const result = {
				_tag: "Checked",
				result: { _tag: "Excluded", cardUrl, reason: "No publication" },
			} as const
			assert.ok(
				Schema.is(Execution.Conflict)(
					yield* index
						.complete(first, started.generation, result)
						.pipe(Effect.flip),
				),
			)
			assert.strictEqual(
				Option.getOrThrow(yield* index.job(cardUrl)).check,
				null,
			)
			yield* index.complete(second, resumed.generation, result)
			assert.strictEqual(
				Option.getOrThrow(yield* index.job(cardUrl)).check?._tag,
				"Excluded",
			)
		}),
	)
})
