import { assert, layer } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Authorizer, Policy } from "@nmnmcc/ability"
import {
	Authorization,
	ConnectionId,
	Execution,
	TokenId,
} from "@openbot-build/domain"
import {
	CatalogDiscovery,
	Document,
	Store as Protocol,
} from "@openbot-build/protocol"
import {
	Array as Arr,
	Effect,
	Layer,
	Redacted,
	Ref,
	Schema,
	String as Str,
} from "effect"
import { SqlClient } from "effect/sql"
import { eq } from "drizzle-orm"
import * as Database from "../src/database/DatabasePostgres.ts"
import * as Db from "../src/database/Database.ts"
import {
	appConnections,
	appRecords,
	appSecrets,
} from "../src/database/Schema.ts"
import { executions } from "../src/database/ExecutionSchema.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import * as Records from "../src/errors/Records.ts"
import * as Store from "../src/execution/Store.ts"
import * as Commands from "../src/apps/ConnectionCommands.ts"
import * as Stored from "../src/apps/StoredConnections.ts"
import { Governance } from "../src/apps/Governance.ts"
import {
	GrantCleanup,
	layer as cleanupLayer,
} from "../src/apps/GrantCleanup.ts"
import * as ManualConnection from "../src/apps/ManualConnection.ts"
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
const services = Layer.merge(Store.layer, Records.layer).pipe(
	Layer.provideMerge(
		Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
	),
	Layer.provideMerge(database),
	Layer.provideMerge(NodeServices.layer),
)
const actor = {
	kind: "user_token",
	organizationId: "org",
	userId: "user",
	tokenId: TokenId.make("connection-token"),
} as const
class Rollback extends Schema.TaggedError<
	Rollback,
	{ readonly brand: unique symbol }
>()("Rollback", {}) {}
layer(services, { excludeTestServices: true })((it) => {
	it.effect(
		"connection commands share one owner and commit only the current result",
		() =>
			Effect.gen(function* () {
				const denied = yield* Ref.make(false)
				const auth = Authorizer.layer(Authorization.Auth, {
					policy: () =>
						Ref.get(denied).pipe(
							Effect.map((deny) =>
								Policy.define(Authorization.OpenBot)(function* (_) {
									yield* _.allow("*", "*")
									if (deny) yield* _.deny("write", Authorization.Connection)
								}),
							),
						),
				})
				yield* Effect.gen(function* () {
					const commands = yield* Commands.ConnectionCommands
					const store = yield* Store.Store
					const db = yield* Db.make
					const secrets = yield* Secrets.Secrets
					const owner = Stored.ownerKey(actor)
					const app = Protocol.AppRecord.make({
						cardUrl: "https://app.example/card",
						card: yield* Document.ServerCard.decode({
							$schema: Document.cardSchemaUrl,
							name: "app.example/test",
							version: "1.0.0",
							description: "Test App",
							remotes: [
								{
									type: "streamable-http",
									url: "https://app.example/mcp",
									supportedProtocolVersions: [Document.protocolVersion],
								},
							],
						}),
						sources: [],
					})
					const initial: Stored.StoredConnection = {
						name: "Test",
						revision: 0,
						verification: null,
						connection: Protocol.UserConnection.make({
							owner,
							connectionId: "connection",
							cardUrl: app.cardUrl,
							endpoint: "https://app.example/mcp",
							remoteIndex: 0,
							headers: Redacted.make({ "X-Secret": "private-value" }),
							configuration: Redacted.make({}),
							state: "Enabled",
							authorization: { _tag: "Unprotected" },
						}),
					}
					yield* db.insert(appRecords).values({
						owner,
						cardUrl: app.cardUrl,
						body: yield* Schema.encodeEffect(Stored.appCodec)(app),
					})
					yield* db.insert(appConnections).values({
						owner,
						id: "connection",
						name: initial.name,
						revision: 0,
						body: yield* secrets.seal(
							yield* Schema.encodeEffect(
								Schema.fromJsonString(
									Schema.toCodecJson(Stored.StoredConnection),
								),
							)(initial),
							yield* Schema.encodeEffect(
								Schema.fromJsonString(Schema.Array(Schema.String)),
							)(["connection", owner, "connection"]),
						),
					})
					const action: Commands.Action = {
						_tag: "Update",
						request: { revision: 0, name: "Stopped", enabled: false },
					}
					const key = Execution.CommandKey.make("stop")
					const receipts = yield* Effect.all(
						Arr.makeBy(8, () =>
							commands.start(actor, "connection", action, key),
						),
						{ concurrency: "unbounded" },
					)
					const id = receipts[0]!.executionId
					assert.isTrue(
						Arr.every(receipts, (receipt) => receipt.executionId === id),
					)
					const execution = { namespace: owner, id }
					assert.deepEqual(
						(yield* store.loadMember(execution)).identity.actor,
						actor,
					)
					assert.propertyVal(
						yield* commands
							.start(actor, "connection", { _tag: "Verify" }, key)
							.pipe(Effect.flip),
						"_tag",
						"ExecutionKeyConflict",
					)
					assert.propertyVal(
						yield* commands
							.start(
								actor,
								"connection",
								{ _tag: "Verify" },
								Execution.CommandKey.make("verify-busy"),
							)
							.pipe(Effect.flip),
						"_tag",
						"ExecutionConflict",
					)
					assert.propertyVal(
						yield* commands
							.start({ ...actor, userId: "other" }, "connection", action, key)
							.pipe(Effect.flip),
						"_tag",
						"ExecutionNotFound",
					)
					const old = yield* store.takeOver(execution)
					const current = yield* store.takeOver(execution)
					const prepared: Commands.Prepared = {
						app,
						capabilities: null,
						discardCredential: false,
						connection: {
							...initial,
							name: "Stopped",
							connection: { ...initial.connection, state: "Disabled" },
						},
					}
					const call = yield* store.readAttempt(current, "prepare", {})
					yield* store.sending(current, call.id)
					yield* store.finishCall(
						current,
						call.id,
						yield* Schema.encodeEffect(Commands.preparedCodec)(prepared),
					)
					assert.propertyVal(
						yield* commands.commit(old, prepared, call.id).pipe(Effect.flip),
						"_tag",
						"ExecutionConflict",
					)
					assert.propertyVal(
						yield* commands
							.authorize(
								current,
								{ ...actor, tokenId: TokenId.make("other-token") },
								"advance",
							)
							.pipe(Effect.flip),
						"_tag",
						"ExecutionForbidden",
					)
					yield* Ref.set(denied, true)
					assert.propertyVal(
						yield* commands
							.commit(current, prepared, call.id)
							.pipe(Effect.flip),
						"_tag",
						"ExecutionForbidden",
					)
					yield* Ref.set(denied, false)
					yield* commands.commit(current, prepared, call.id)
					const result = yield* commands.get(actor, "connection", id)
					assert.equal(result.execution.status, "completed")
					assert.deepEqual(result.result, {
						_tag: "Updated",
						connectionId: ConnectionId.make("connection"),
						revision: 1,
					})
					assert.equal(
						(yield* Stored.get(db, secrets, owner, "connection")).connection
							.state,
						"Disabled",
					)
					assert.equal(
						(yield* commands.start(actor, "connection", action, key))
							.executionId,
						id,
					)
					const next = yield* commands.start(
						actor,
						"connection",
						{ _tag: "Verify" },
						Execution.CommandKey.make("verify"),
					)
					const nextKey = { namespace: owner, id: next.executionId }
					const fence = yield* store.takeOver(nextKey)
					yield* store.cancel(
						nextKey,
						Execution.CommandKey.make("cancel"),
						actor,
					)
					assert.propertyVal(
						yield* commands.commit(fence, prepared, call.id).pipe(Effect.flip),
						"_tag",
						"ExecutionConflict",
					)
					const state = yield* store.load(nextKey)
					yield* commands.finish(fence, {
						status: "cancelled",
						epoch: state.cancelEpoch,
					})
					assert.equal((yield* store.get(nextKey)).status, "cancelled")
					assert.equal(
						(yield* Stored.get(db, secrets, owner, "connection")).revision,
						1,
					)
					assert.isNull(
						(yield* commands.get(actor, "connection", next.executionId)).result,
					)
					yield* db.delete(appConnections)
					assert.deepEqual(
						(yield* commands.get(actor, "connection", id)).result,
						result.result,
					)
				}).pipe(
					Effect.provide(
						Commands.layer.pipe(
							Layer.provide(CatalogDiscovery.layerRules),
							Layer.provide(auth),
							Layer.provide(
								Layer.mock(Governance, { check: () => Effect.void }),
							),
							Layer.provide(
								Layer.mock(GrantCleanup, {
									assertInstallable: () =>
										Effect.void.pipe(Effect.as(undefined)),
								}),
							),
						),
					),
				)
			}),
	)

	it.effect(
		"a connection change gives its old grant to cleanup in the same transaction",
		() =>
			Effect.gen(function* () {
				const commands = yield* Commands.ConnectionCommands
				const cleanup = yield* GrantCleanup
				const store = yield* Store.Store
				const db = yield* Db.make
				const sql = yield* SqlClient.SqlClient
				const secrets = yield* Secrets.Secrets
				const owner = Stored.ownerKey(actor)
				const id = ConnectionId.make("manual-grant")
				const request = {
					id,
					name: "Manual App",
					url: "https://old.example/mcp",
					transport: "streamable-http" as const,
					headers: {},
				}
				const configured = yield* ManualConnection.configure(owner)(request)
				const credential = Protocol.Credential.make({
					binding: {
						owner,
						connectionId: id,
						resource: request.url,
						issuer: "https://issuer.example",
					},
					clientId: "https://host.example/client",
					accessToken: Redacted.make("private-access-token"),
					refreshToken: Redacted.make("private-refresh-token"),
					scopes: ["read"],
				})
				const reference = "manual-grant-credential"
				const initial: Stored.StoredConnection = {
					name: request.name,
					revision: 0,
					verification: null,
					connection: {
						...configured.connection,
						authorization: {
							_tag: "Authorized",
							binding: credential.binding,
							credentialRef: reference,
							scopes: credential.scopes,
							resourceMetadataUrl: "https://old.example/metadata",
						},
					},
				}
				yield* db.insert(appRecords).values({
					owner,
					cardUrl: configured.app.cardUrl,
					body: yield* Schema.encodeEffect(Stored.appCodec)(configured.app),
				})
				yield* db.insert(appConnections).values({
					owner,
					id,
					name: initial.name,
					revision: 0,
					body: yield* secrets.seal(
						yield* Schema.encodeEffect(
							Schema.fromJsonString(
								Schema.toCodecJson(Stored.StoredConnection),
							),
						)(initial),
						yield* Schema.encodeEffect(
							Schema.fromJsonString(Schema.Array(Schema.String)),
						)(["connection", owner, id]),
					),
				})
				yield* db.insert(appSecrets).values({
					owner,
					id: reference,
					connectionId: id,
					kind: "credential",
					body: yield* secrets.seal(
						yield* Schema.encodeEffect(
							Schema.fromJsonString(Schema.toCodecJson(Protocol.Credential)),
						)(credential),
						yield* Schema.encodeEffect(
							Schema.fromJsonString(Schema.Array(Schema.String)),
						)(["credential", owner, reference]),
					),
				})
				const action: Commands.Action = {
					_tag: "Manual",
					request: { ...request, revision: 0, url: "https://new.example/mcp" },
				}
				const receipt = yield* commands.start(
					actor,
					id,
					action,
					Execution.CommandKey.make("manual-grant-change"),
				)
				const fence = yield* store.takeOver({
					namespace: owner,
					id: receipt.executionId,
				})
				const target = yield* ManualConnection.configure(owner)({
					...request,
					url: action.request.url,
				})
				const prepared: Commands.Prepared = {
					app: target.app,
					connection: { ...initial, connection: target.connection },
					capabilities: null,
					discardCredential: true,
				}
				const call = yield* store.readAttempt(fence, "prepare", {})
				yield* store.sending(fence, call.id)
				yield* store.finishCall(
					fence,
					call.id,
					yield* Schema.encodeEffect(Commands.preparedCodec)(prepared),
				)
				const cleanupRows = db
					.select()
					.from(executions)
					.where(eq(executions.workflow, "openbot.app-grant-cleanup"))
				const before = yield* cleanupRows
				assert.equal(
					(yield* sql
						.withTransaction(
							commands
								.commit(fence, prepared, call.id)
								.pipe(Effect.andThen(Rollback.make({}))),
						)
						.pipe(Effect.flip))._tag,
					"Rollback",
				)
				assert.deepEqual(yield* cleanupRows, before)
				assert.equal((yield* store.get(fence)).status, "running")
				assert.equal(
					(yield* Stored.get(db, secrets, owner, id)).connection.authorization
						._tag,
					"Authorized",
				)
				assert.equal(
					(yield* db
						.select()
						.from(appSecrets)
						.where(eq(appSecrets.id, reference))).length,
					1,
				)

				yield* commands.commit(fence, prepared, call.id)
				assert.equal(
					(yield* Stored.get(db, secrets, owner, id)).connection.authorization
						._tag,
					"Unprotected",
				)
				assert.equal(
					(yield* db
						.select()
						.from(appSecrets)
						.where(eq(appSecrets.id, reference))).length,
					0,
				)
				const added = Arr.filter(
					yield* cleanupRows,
					(row) => !Arr.some(before, (old) => old.id === row.id),
				)
				assert.equal(added.length, 1)
				assert.isTrue(Arr.isReadonlyArrayNonEmpty(added))
				if (!Arr.isReadonlyArrayNonEmpty(added)) return
				const cleanupKey = {
					namespace: owner,
					id: Execution.Id.make(Arr.headNonEmpty(added).id),
				}
				const saved = yield* cleanup.load(cleanupKey)
				assert.isTrue(saved.detached)
				assert.equal(
					Redacted.value(saved.grant.credential.accessToken),
					"private-access-token",
				)
				assert.equal(
					saved.grant.resourceMetadataUrl,
					"https://old.example/metadata",
				)
				const again = yield* cleanup.handoff(fence, reference, credential, {
					resourceMetadataUrl: "https://old.example/metadata",
				})
				assert.equal(again.executionId, cleanupKey.id)
				const cleanupFence = yield* store.takeOver(cleanupKey)
				assert.equal((yield* cleanup.claim(cleanupFence))._tag, "Revoke")
				yield* cleanup.complete(cleanupFence)
				assert.equal((yield* store.get(cleanupKey)).status, "completed")
			}).pipe(
				Effect.provide(
					Commands.layer.pipe(
						Layer.provideMerge(cleanupLayer),
						Layer.provide(CatalogDiscovery.layerRules),
						Layer.provide(
							Authorizer.layer(Authorization.Auth, {
								policy: () =>
									Effect.succeed(
										Policy.define(Authorization.OpenBot)(function* (_) {
											yield* _.allow("*", "*")
										}),
									),
							}),
						),
						Layer.provide(Layer.mock(Governance, { check: () => Effect.void })),
					),
				),
			),
	)
})
