import * as GrantCleanup from "../src/apps/GrantCleanup.ts"
import { SqlClient } from "effect/sql"
import * as TestStores from "../src/apps/DeveloperTestStores.ts"
import { assert, layer } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Authorizer, Policy } from "@nmnmcc/ability"
import { Authorization, Execution, TokenId } from "@openbot-build/domain"
import {
	Discovery,
	Document,
	Store as ProtocolStore,
} from "@openbot-build/protocol"
import {
	Array as Arr,
	Clock,
	Option,
	Effect,
	Layer,
	Redacted,
	Ref,
	Schema,
	String as Str,
} from "effect"
import * as Database from "../src/database/DatabasePostgres.ts"
import * as Db from "../src/database/Database.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import * as Records from "../src/errors/Records.ts"
import * as Store from "../src/execution/Store.ts"
import * as Observation from "../src/execution/Observation.ts"
import * as Cleanup from "../src/apps/TestCleanup.ts"
import * as Engine from "../src/execution/Engine.ts"
import { WorkflowEngine } from "effect/workflow"
import { developerTests } from "../src/database/Schema.ts"
import { eq } from "drizzle-orm"
import * as Rows from "../src/apps/DeveloperRows.ts"
import { DeveloperAccess } from "../src/apps/DeveloperAccess.ts"
import { ownerKey } from "../src/apps/StoredConnections.ts"
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
const services = Observation.layer.pipe(
	Layer.provideMerge(Layer.merge(Store.layer, Records.layer)),
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
	tokenId: TokenId.make("cleanup-token"),
} as const
layer(services, { excludeTestServices: true })((it) => {
	it.effect(
		"cleanup keeps its owner, private data, and grant reservation across takeover",
		() =>
			Effect.gen(function* () {
				const denied = yield* Ref.make(false)
				const auth = Authorizer.layer(Authorization.Auth, {
					policy: () =>
						Ref.get(denied).pipe(
							Effect.map((deny) =>
								Policy.define(Authorization.OpenBot)(function* (_) {
									yield* _.allow("*", "*")
									if (deny) yield* _.deny("publish", Authorization.App)
								}),
							),
						),
				})
				yield* Effect.gen(function* () {
					const cleanup = yield* Cleanup.TestCleanup
					const grants = yield* GrantCleanup.GrantCleanup
					const store = yield* Store.Store
					const tests = yield* TestStores.DeveloperTestStores
					const db = yield* Db.make
					const sql = yield* SqlClient.SqlClient
					const owner = ownerKey(actor)
					const candidate = yield* Schema.decodeEffect(Discovery.Candidate)({
						cardUrl: "https://test.example/card.json",
						card: {
							$schema: Document.cardSchemaUrl,
							name: "test.example/app",
							version: "1.0.0",
							description: "Test App",
							remotes: [
								{
									type: "streamable-http",
									url: "https://test.example/mcp",
									supportedProtocolVersions: [Document.protocolVersion],
								},
							],
						},
						endpoints: [],
						sources: [],
					})
					const now = yield* Clock.currentTimeMillis
					const key = yield* sql.withTransaction(
						Effect.gen(function* () {
							yield* Rows.putTest(db, "public", {
								owner,
								resourceMetadataUrl: null,
								value: {
									id: "cleanup-test",
									cardUrl: candidate.cardUrl,
									candidate,
									remoteIndex: 0,
									endpoint: "https://test.example/mcp",
									configurationKeys: ["secret"],
									issuers: [],
									requestedScopes: [],
									createdAt: now,
									expiresAt: now + 3600000,
									status: "Queued",
									checkedAt: null,
									cleanup: "NotRequired",
									cleanupRemote: "Pending",
									cleanupLocal: "Pending",
									authorization: null,
									stages: [],
									reason: null,
								},
							})
							return yield* cleanup.ensure(
								yield* Rows.getTest(db, "public", "cleanup-test", true),
							)
						}),
					)
					const connection = yield* ProtocolStore.UserConnection.decode({
						owner,
						connectionId: "cleanup-test",
						cardUrl: candidate.cardUrl,
						endpoint: "https://test.example/mcp",
						remoteIndex: 0,
						state: "Enabled",
						authorization: { _tag: "Unprotected" },
						configuration: Redacted.make({ secret: "test-secret" }),
						headers: Redacted.make({}),
					})
					yield* tests.bind(owner, "cleanup-test").apps.save({
						app: ProtocolStore.AppRecord.make(candidate),
						connection,
					})
					const bound = tests.bind(owner, "cleanup-test")
					const credential = ProtocolStore.Credential.make({
						binding: {
							owner,
							connectionId: "cleanup-test",
							resource: connection.endpoint,
							issuer: "https://test.example",
						},
						clientId: "test-client",
						scopes: [],
						accessToken: Redacted.make("private-test-access"),
						refreshToken: Redacted.make("private-test-refresh"),
					})
					yield* bound.credentials.put(credential)
					const reference = yield* bound.credentials.put({
						...credential,
						accessToken: Redacted.make("private-new-access"),
					})
					yield* bound.apps.update({
						key: connection,
						change: (value) => ({
							...value,
							authorization: {
								_tag: "Authorized",
								binding: credential.binding,
								credentialRef: reference,
								scopes: [],
							},
						}),
					})
					const commandKey = Execution.CommandKey.make("cleanup-once")
					const replies = yield* Effect.all(
						Arr.makeBy(8, () =>
							cleanup.request(actor, "cleanup-test", commandKey, false),
						),
						{ concurrency: "unbounded" },
					)
					assert.isTrue(
						Arr.every(replies, (receipt) => receipt.executionId === key.id),
					)
					assert.propertyVal(
						yield* cleanup
							.request(actor, "cleanup-test", commandKey, true)
							.pipe(Effect.flip),
						"_tag",
						"ExecutionKeyConflict",
					)
					assert.propertyVal(
						yield* cleanup
							.request(
								{ ...actor, userId: "other" },
								"cleanup-test",
								commandKey,
								false,
							)
							.pipe(Effect.flip),
						"_tag",
						"DeveloperNotFound",
					)
					const registry = yield* Engine.Registry
					yield* registry.registerService(
						Engine.define(Cleanup.workflowName),
						Cleanup.serviceId,
						cleanup.serviceAuthorize,
						undefined,
						cleanup.authorize,
					)
					const registered = yield* registry
						.get(Cleanup.workflowName)
						.pipe(
							Effect.flatMap(
								Effect.fromOption(() => "The cleanup workflow is missing."),
							),
						)
					yield* registered.authorize(key, actor, "read")
					assert.propertyVal(
						yield* registered
							.authorize(key, actor, "advance")
							.pipe(Effect.flip),
						"_tag",
						"ExecutionForbidden",
					)
					assert.propertyVal(
						yield* registered.authorize(key, actor, "cancel").pipe(Effect.flip),
						"_tag",
						"ExecutionForbidden",
					)
					const old = yield* store.takeOver(key)
					const current = yield* store.takeOver(key)
					assert.propertyVal(
						yield* cleanup.complete(old).pipe(Effect.flip),
						"_tag",
						"ExecutionConflict",
					)
					assert.equal(
						(yield* tests.bind(owner, "cleanup-test").apps.get(connection))
							.connectionId,
						"cleanup-test",
					)
					assert.propertyVal(
						yield* cleanup.transfer(old).pipe(Effect.flip),
						"_tag",
						"ExecutionConflict",
					)
					assert.equal(
						(yield* bound.snapshot).connection?.authorization._tag,
						"Authorized",
					)
					yield* cleanup.transfer(current)
					const jobs = (yield* cleanup.current(current)).grants
					assert.equal(jobs.length, 2)
					for (const id of jobs) {
						assert.deepEqual(yield* store.locate(id, actor.organizationId), {
							namespace: owner,
							id,
						})
						assert.propertyVal(
							yield* store.locate(id, "other-org").pipe(Effect.flip),
							"_tag",
							"ExecutionNotFound",
						)
					}
					const child = yield* store.load({ namespace: owner, id: jobs[0]! })
					assert.deepEqual(child.identity.owner, {
						kind: "organization",
						organizationId: actor.organizationId,
					})
					assert.deepEqual(child.identity.actor, {
						kind: "service",
						serviceId: GrantCleanup.serviceId,
					})
					const wrongOwner = yield* store.submit(
						owner,
						Execution.CommandKey.make("wrong-grant-owner"),
						{
							workflow: GrantCleanup.workflowName,
							identity: {
								owner: { kind: "organization", organizationId: "other-org" },
								actor: { kind: "service", serviceId: GrantCleanup.serviceId },
							},
							resource: child.record.resource,
							input: child.input,
						},
					)
					assert.propertyVal(
						yield* grants
							.load({ namespace: owner, id: wrongOwner.executionId })
							.pipe(Effect.flip),
						"_tag",
						"ExecutionForbidden",
					)
					yield* cleanup.transfer(current)
					assert.deepEqual((yield* cleanup.current(current)).grants, jobs)
					assert.equal(
						(yield* bound.snapshot).connection?.authorization._tag,
						"AuthorizationFailed",
					)
					assert.equal((yield* bound.snapshot).credentials.length, 2)
					assert.equal((yield* store.get(key)).status, "running")
					assert.isTrue(Option.isSome(yield* cleanup.complete(current)))
					const rawJobs = yield* sql<{
						input: string
					}>`select input from openbot_executions where workflow='openbot.app-grant-cleanup'`
					assert.isTrue(
						Arr.every(
							rawJobs,
							(row) =>
								!Str.includes("private-test-")(row.input) &&
								!Str.includes("private-new-access")(row.input),
						),
					)
					for (const id of jobs) {
						const job = { namespace: owner, id }
						const fence = yield* store.takeOver(job)
						const claimed = yield* grants.claim(fence)
						assert.equal(claimed._tag, "Revoke")
						if (claimed._tag === "Revoke") {
							assert.equal(
								Redacted.value(claimed.grant.credential.refreshToken!),
								"private-test-refresh",
							)
						}
						const call = yield* Arr.findFirst(
							yield* store.calls(job),
							(value) => value.step === "revoke",
						).pipe(Effect.fromOption(() => "The grant call is missing."))
						yield* store.sending(fence, call.id)
						yield* store.finishCall(fence, call.id, {
							_tag: "Completed",
							value: { _tag: "LocalOnly" },
						})
						yield* grants.complete(fence)
					}
					const reservation = yield* store.submit(
						owner,
						Execution.CommandKey.make("grant-reservation"),
						{
							workflow: "openbot.app-grant-cleanup",
							identity: {
								owner: { kind: "platform" },
								actor: { kind: "service", serviceId: Cleanup.serviceId },
							},
							resource: { kind: "AppGrant", id: "grant" },
							input: {},
						},
					)
					yield* db
						.update(developerTests)
						.set({ grantCleanupExecutionId: reservation.executionId })
						.where(eq(developerTests.id, "cleanup-test"))
					assert.deepEqual(
						yield* cleanup.complete(current),
						Option.some({ namespace: owner, id: reservation.executionId }),
					)
					assert.equal(
						(yield* tests.bind(owner, "cleanup-test").apps.get(connection))
							.connectionId,
						"cleanup-test",
					)
					yield* Ref.set(denied, true)
					assert.propertyVal(
						yield* registered.authorize(key, actor, "read").pipe(Effect.flip),
						"_tag",
						"ExecutionForbidden",
					)
					yield* registered.authorize(
						key,
						{ kind: "service", serviceId: Cleanup.serviceId },
						"advance",
					)
					yield* db
						.update(developerTests)
						.set({ grantCleanupExecutionId: null })
						.where(eq(developerTests.id, "cleanup-test"))
					assert.isTrue(Option.isNone(yield* cleanup.complete(current)))
					const ended = yield* Rows.getTest(db, "public", "cleanup-test")
					assert.equal(ended.value.cleanup, "Complete")
					assert.equal(ended.value.cleanupRemote, "LocalOnly")
					assert.equal(ended.value.status, "Cancelled")
					assert.equal((yield* store.get(key)).status, "completed")
					assert.propertyVal(
						yield* tests
							.bind(owner, "cleanup-test")
							.apps.get(connection)
							.pipe(Effect.flip),
						"reason",
						"Missing",
					)
					yield* Ref.set(denied, false)
					const removed = yield* cleanup.request(
						actor,
						"cleanup-test",
						Execution.CommandKey.make("remove-once"),
						true,
					)
					const removeKey = { namespace: owner, id: removed.executionId }
					const removeFence = yield* store.takeOver(removeKey)
					yield* cleanup.transfer(removeFence)
					yield* cleanup.complete(removeFence)
					assert.isTrue(
						Option.isNone(yield* Rows.findTest(db, "public", "cleanup-test")),
					)
					yield* cleanup.authorize(removeKey, actor, "read")
					assert.deepEqual(
						yield* cleanup.request(
							actor,
							"cleanup-test",
							Execution.CommandKey.make("remove-once"),
							true,
						),
						removed,
					)
				}).pipe(
					Effect.provide(
						Cleanup.layer.pipe(
							Layer.provideMerge(GrantCleanup.layer),
							Layer.provideMerge(TestStores.layer),
							Layer.provideMerge(
								Engine.layerRegistry.pipe(
									Layer.provide(WorkflowEngine.layerMemory),
								),
							),
							Layer.provide(auth),
							Layer.provide(
								Layer.mock(DeveloperAccess, {
									allows: () =>
										Ref.get(denied).pipe(Effect.map((value) => !value)),
								}),
							),
						),
					),
				)
			}),
	)
})
