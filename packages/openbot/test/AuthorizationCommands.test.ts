import * as ErrorRecords from "../src/errors/Records.ts"
import * as CleanupWorkflow from "../src/apps/GrantCleanupWorkflow.ts"
import { AppNetwork } from "../src/apps/AppHost.ts"
import * as Engine from "../src/execution/Engine.ts"
import * as Calls from "../src/execution/Calls.ts"
import * as Runner from "../src/execution/Runner.ts"
import * as RunScope from "../src/execution/RunScope.ts"
import * as Observation from "../src/execution/Observation.ts"
import * as Records from "../src/errors/Records.ts"
import { Billing } from "../src/billing/Billing.ts"
import { WorkflowEngine } from "effect/workflow"
import * as Cleanup from "../src/apps/GrantCleanup.ts"
import { assert, layer } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Authorizer, Policy } from "@nmnmcc/ability"
import { Authorization, Execution, TokenId } from "@openbot-build/domain"
import {
	Authorization as OAuth,
	OAuthAuthorization,
	Network,
	Store as Protocol,
} from "@openbot-build/protocol"
import {
	Array as Arr,
	Effect,
	Layer,
	Option,
	Redacted,
	Ref,
	Schema,
	Stream,
	String as Str,
} from "effect"
import { SqlClient } from "effect/sql"
import * as Database from "../src/database/DatabasePostgres.ts"
import * as Db from "../src/database/Database.ts"
import {
	appAuthorizations,
	appConnections,
	appSecrets,
} from "../src/database/Schema.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import * as Store from "../src/execution/Store.ts"
import * as Commands from "../src/apps/AuthorizationCommands.ts"
import { Governance } from "../src/apps/Governance.ts"
import * as Connections from "../src/apps/StoredConnections.ts"
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
const services = Layer.merge(Store.layer, ErrorRecords.layer).pipe(
	Layer.provideMerge(
		Secrets.layer(Redacted.make("test:" + Str.repeat(32)("21"))),
	),
	Layer.provideMerge(database),
	Layer.provideMerge(NodeServices.layer),
)
const original = {
	kind: "user_token",
	organizationId: "org",
	userId: "user",
	tokenId: TokenId.make("original-token"),
} as const
const actor = { kind: "member", organizationId: "org", userId: "user" } as const
const owner = Connections.ownerKey(actor)
const binding = (kind: string, id: string) => JSON.stringify([kind, owner, id])
class Rollback extends Schema.TaggedError<
	Rollback,
	{ readonly brand: unique symbol }
>()("Rollback", {}) {}
layer(services, { excludeTestServices: true })((it) => {
	it.effect(
		"authorization commands keep the original token, one owner, and one state commit",
		() =>
			Effect.gen(function* () {
				const revoked = yield* Ref.make(false)
				const auth = Authorizer.layer(Authorization.Auth, {
					policy: (caller) =>
						Ref.get(revoked).pipe(
							Effect.map((deny) =>
								Policy.define(Authorization.OpenBot)(function* (_) {
									yield* _.allow("*", "*")
									if (deny && caller.kind === "user_token")
										yield* _.deny("write", Authorization.Connection)
								}),
							),
						),
				})
				yield* Effect.gen(function* () {
					const commands = yield* Commands.AuthorizationCommands
					const cleanup = yield* Cleanup.GrantCleanup
					const store = yield* Store.Store
					const secrets = yield* Secrets.Secrets
					const db = yield* Db.make
					const sql = yield* SqlClient.SqlClient
					const connection = Connections.StoredConnection.make({
						name: "App",
						revision: 0,
						verification: null,
						connection: Protocol.UserConnection.make({
							owner,
							connectionId: "connection",
							cardUrl: "https://app.example/card",
							endpoint: "https://app.example/mcp",
							remoteIndex: 0,
							configuration: Redacted.make({}),
							headers: Redacted.make({}),
							state: "Enabled",
							authorization: {
								_tag: "PendingAuthorization",
								resource: "https://app.example/mcp",
								scopes: [],
							},
						}),
					})
					const flow = OAuth.Flow.make({
						flowId: "flow",
						binding: {
							owner,
							connectionId: "connection",
							resource: "https://app.example/mcp",
							issuer: "https://issuer.example",
						},
						clientId: "https://host.example/client",
						redirectUri: "https://host.example/callback",
						scopes: ["read"],
						verifier: Redacted.make("private-verifier"),
						expiresAt: 9999999999999,
						metadata: OAuth.ServerMetadata.make({
							issuer: "https://issuer.example",
							authorization_endpoint: "https://issuer.example/authorize",
							token_endpoint: "https://issuer.example/token",
							revocation_endpoint: "https://issuer.example/revoke",
							code_challenge_methods_supported: ["S256"],
							response_types_supported: ["code"],
							authorization_response_iss_parameter_supported: true,
						}),
					})
					const callback =
						"https://host.example/callback?state=flow&code=private-code&iss=https%3A%2F%2Fissuer.example"
					yield* db.insert(appConnections).values({
						owner,
						id: "connection",
						revision: 0,
						name: "App",
						body: yield* secrets.seal(
							yield* Schema.encodeEffect(
								Schema.fromJsonString(
									Schema.toCodecJson(Connections.StoredConnection),
								),
							)(connection),
							binding("connection", "connection"),
						),
					})
					const preparation = yield* commands.start(
						original,
						{
							kind: "Begin",
							connectionId: "connection",
							input: { revision: 0, scopes: ["read"] },
						},
						Execution.CommandKey.make("prepare"),
					)
					const preparationKey = {
						namespace: owner,
						id: preparation.executionId,
					}
					const oldPreparation = yield* store.takeOver(preparationKey)
					const prepared: Commands.Preparation = {
						flow,
						result: {
							_tag: "AuthorizationStarted",
							flowId: flow.flowId,
							authorizationUrl: "https://issuer.example/authorize",
							issuer: flow.binding.issuer,
							scopes: flow.scopes,
						},
					}
					const call = yield* store.readAttempt(oldPreparation, "prepare", {
						connectionId: "connection",
					})
					yield* store.sending(oldPreparation, call.id)
					yield* store.finishCall(
						oldPreparation,
						call.id,
						yield* Schema.encodeEffect(Commands.preparationCodec)(prepared),
					)
					assert.equal(
						(yield* commands.get(actor, preparationKey.id)).result,
						null,
					)
					const preparationFence = yield* store.takeOver(preparationKey)
					assert.propertyVal(
						yield* commands
							.commitPrepared(oldPreparation, prepared)
							.pipe(Effect.flip),
						"_tag",
						"ExecutionConflict",
					)
					yield* sql
						.withTransaction(
							commands
								.commitPrepared(preparationFence, prepared)
								.pipe(Effect.andThen(Effect.fail(Rollback.make({})))),
						)
						.pipe(Effect.flip)
					assert.equal((yield* db.select().from(appAuthorizations)).length, 0)
					assert.equal((yield* db.select().from(appSecrets)).length, 0)

					assert.equal((yield* store.get(preparationKey)).status, "running")
					yield* commands.commitPrepared(preparationFence, prepared)
					assert.equal(
						(yield* commands.get(actor, preparationKey.id)).result?._tag,
						"AuthorizationStarted",
					)
					assert.equal(
						(yield* db.select().from(appAuthorizations))[0]?.executionId,
						preparationKey.id,
					)
					yield* db.update(appAuthorizations).set({
						status: "Received",
						callback: yield* secrets.seal(
							callback,
							binding("app-authorization", "flow"),
						),
					})
					const receipts = yield* Effect.all(
						Arr.makeBy(8, () =>
							commands.start(
								actor,
								{ kind: "Complete", flowId: "flow" },
								Execution.CommandKey.make("one"),
							),
						),
						{ concurrency: "unbounded" },
					)
					const key = { namespace: owner, id: receipts[0]!.executionId }
					assert.isTrue(
						Arr.every(receipts, (receipt) => receipt.executionId === key.id),
					)
					assert.deepEqual(
						(yield* store.loadMember(key)).identity.constraints,
						[original],
					)
					assert.propertyVal(
						yield* commands
							.start(
								actor,
								{ kind: "Revoke", connectionId: "connection" },
								Execution.CommandKey.make("other"),
							)
							.pipe(Effect.flip),
						"_tag",
						"ExecutionConflict",
					)
					assert.propertyVal(
						yield* commands
							.get({ ...actor, userId: "other" }, key.id)
							.pipe(Effect.flip),
						"_tag",
						"ExecutionNotFound",
					)
					assert.propertyVal(
						yield* Connections.update(
							db,
							secrets,
							owner,
							"connection",
							(row) => row,
						).pipe(Effect.flip),
						"_tag",
						"ConnectionConflict",
					)
					const first = yield* store.takeOver(key)
					const second = yield* store.takeOver(key)
					const grant = {
						credential: Protocol.Credential.make({
							binding: flow.binding,
							accessToken: Redacted.make("private-access"),
							refreshToken: Redacted.make("private-refresh"),
							clientId: flow.clientId,
							scopes: ["read"],
						}),
					}
					const grantCall = yield* cleanup.writeAttempt(
						second,
						"exchange",
						{
							flowId: "flow",
						},
						Cleanup.scopeOf(grant.credential),
					)
					yield* store.sending(second, grantCall.id)
					yield* store.finishCall(
						second,
						grantCall.id,
						yield* Schema.encodeEffect(
							Schema.toCodecJson(OAuthAuthorization.Grant),
						)(grant),
					)
					const cleanupReceipt = yield* cleanup.enqueue(
						second,
						grantCall.id,
						flow.metadata,
					)
					assert.equal(
						(yield* cleanup.enqueue(second, grantCall.id, flow.metadata))
							.executionId,
						cleanupReceipt.executionId,
					)
					const cleanupKey = {
						namespace: owner,
						id: cleanupReceipt.executionId,
					}
					assert.deepEqual(
						yield* store.locate(cleanupKey.id, actor.organizationId),
						cleanupKey,
					)
					assert.propertyVal(
						yield* store.locate(cleanupKey.id, "other-org").pipe(Effect.flip),
						"_tag",
						"ExecutionNotFound",
					)
					const cleanupFence = yield* store.takeOver(cleanupKey)
					assert.equal((yield* cleanup.claim(cleanupFence))._tag, "Wait")

					const result = { callId: grantCall.id, grant }

					assert.propertyVal(
						yield* commands.commit(first, result).pipe(Effect.flip),
						"_tag",
						"ExecutionConflict",
					)
					yield* Ref.set(revoked, true)
					assert.propertyVal(
						yield* commands.authorize(key, actor, "advance").pipe(Effect.flip),
						"_tag",
						"ExecutionForbidden",
					)
					assert.propertyVal(
						yield* commands.commit(second, result).pipe(Effect.flip),
						"_tag",
						"ExecutionForbidden",
					)
					yield* Ref.set(revoked, false)
					yield* sql
						.withTransaction(
							commands
								.commit(second, result)
								.pipe(Effect.andThen(Effect.fail(Rollback.make({})))),
						)
						.pipe(Effect.flip)
					assert.equal(
						(yield* db.select().from(appAuthorizations))[0]?.status,
						"Processing",
					)
					assert.equal((yield* db.select().from(appSecrets)).length, 1)
					yield* commands.commit(second, result)
					assert.equal((yield* store.get(key)).status, "completed")
					assert.equal(
						(yield* db.select().from(appAuthorizations))[0]?.status,
						"Succeeded",
					)
					assert.equal(
						(yield* db.select().from(appConnections))[0]?.executionId,
						null,
					)
					const stored = yield* Connections.get(
						db,
						secrets,
						owner,
						"connection",
					)
					assert.equal(stored.connection.authorization._tag, "Authorized")
					const raw = yield* sql<{
						input: string
					}>`SELECT input FROM openbot_executions WHERE id=${key.id}`
					assert.notInclude(raw[0]!.input, "private-code")
					assert.notInclude(raw[0]!.input, "private-verifier")
					assert.equal(
						(yield* commands.get(actor, key.id)).result?._tag,
						"Authorized",
					)
					yield* Ref.set(revoked, true)
					yield* cleanup.authorize(cleanupKey)
					assert.equal((yield* cleanup.claim(cleanupFence))._tag, "Retained")
					yield* cleanup.complete(cleanupFence)
					yield* Ref.set(revoked, false)

					const revoke = yield* commands.start(
						actor,
						{ kind: "Revoke", connectionId: "connection" },
						Execution.CommandKey.make("revoke"),
					)
					const revokeKey = { namespace: owner, id: revoke.executionId }
					const fence = yield* store.takeOver(revokeKey)
					yield* store.cancel(
						revokeKey,
						Execution.CommandKey.make("cancel"),
						actor,
					)
					yield* commands.finish(fence, {
						status: "cancelled",
						epoch: (yield* store.loadMember(revokeKey)).cancelEpoch,
					})
					assert.equal((yield* store.get(revokeKey)).status, "cancelled")
					assert.equal(
						(yield* Connections.get(db, secrets, owner, "connection"))
							.connection.state,
						"Disabled",
					)
					assert.equal(
						(yield* db.select().from(appConnections))[0]?.executionId,
						null,
					)
					const refresh = yield* commands.start(
						actor,
						{ kind: "Refresh", connectionId: "connection" },
						Execution.CommandKey.make("refresh-late"),
					)
					const refreshKey = { namespace: owner, id: refresh.executionId }
					const oldRefresh = yield* store.takeOver(refreshKey)
					const refreshCall = yield* cleanup.writeAttempt(
						oldRefresh,
						"refresh",
						{
							connectionId: "connection",
						},
						Cleanup.scopeOf(grant.credential),
					)
					yield* store.sending(oldRefresh, refreshCall.id)
					const newRefresh = yield* store.takeOver(refreshKey)
					yield* commands.finish(newRefresh, { status: "interrupted" })
					const lateGrant = {
						credential: {
							...grant.credential,
							accessToken: Redacted.make("late-access"),
							refreshToken: Redacted.make("late-refresh"),
						},
					}
					const lateBody = yield* Schema.encodeEffect(
						Schema.toCodecJson(OAuthAuthorization.Grant),
					)(lateGrant)
					// A lost result save must not leave a cleanup job or a partial result.
					yield* sql
						.withTransaction(
							store
								.finishCall(
									oldRefresh,
									refreshCall.id,
									lateBody,
									[],
									cleanup
										.enqueue(oldRefresh, refreshCall.id, flow.metadata)
										.pipe(Effect.asVoid),
								)
								.pipe(Effect.andThen(Effect.fail(Rollback.make({})))),
						)
						.pipe(Effect.flip)
					assert.equal((yield* store.calls(refreshKey))[0]?.status, "sending")
					const rolledBackJobs = yield* sql<{
						count: number
					}>`select count(*)::int as count from openbot_executions where namespace=${owner} and resource_kind='AppGrant' and resource_id=${refreshCall.id}`
					assert.equal(rolledBackJobs[0]?.count, 0)

					assert.isFalse(
						yield* store.finishCall(
							oldRefresh,
							refreshCall.id,
							lateBody,
							[],
							cleanup
								.enqueue(oldRefresh, refreshCall.id, flow.metadata)
								.pipe(Effect.asVoid),
						),
					)
					const lateReceipt = yield* cleanup.enqueue(
						oldRefresh,
						refreshCall.id,
						flow.metadata,
					)
					const lateKey = { namespace: owner, id: lateReceipt.executionId }
					const lateFence = yield* store.takeOver(lateKey)
					yield* Ref.set(revoked, true)
					assert.equal((yield* cleanup.claim(lateFence))._tag, "InUse")
					// A different token can still be part of the current remote grant family.
					yield* Connections.update(
						db,
						secrets,
						owner,
						"connection",
						(current) => ({
							...current,
							connection: {
								...current.connection,
								authorization: { _tag: "Unprotected" },
							},
						}),
					)
					const inFlightReceipt = yield* store.submit(
						owner,
						Execution.CommandKey.make("other-grant-send"),
						{
							workflow: Commands.workflowName,
							identity: {
								owner: {
									organizationId: actor.organizationId,
									userId: actor.userId,
								},
								actor,
							},
							resource: { kind: "AppAuthorization", id: "other-in-flight" },
							input: {},
						},
					)
					const inFlight = yield* store.takeOver({
						namespace: owner,
						id: inFlightReceipt.executionId,
					})
					yield* cleanup.writeAttempt(
						inFlight,
						"exchange",
						{},
						Cleanup.scopeOf(grant.credential),
					)
					const waitingForCall = yield* cleanup.claim(lateFence)
					assert.equal(waitingForCall._tag, "Wait")
					if (waitingForCall._tag === "Wait")
						assert.equal(waitingForCall.key.id, inFlight.id)
					yield* store.commit(inFlight, { status: "interrupted" }, Effect.void)
					assert.equal((yield* cleanup.claim(lateFence))._tag, "Revoke")
					assert.propertyVal(
						yield* sql
							.withTransaction(
								cleanup.assertInstallable(Cleanup.scopeOf(grant.credential)),
							)
							.pipe(Effect.flip),
						"_tag",
						"ExecutionConflict",
					)
					yield* Ref.set(revoked, false)
					assert.propertyVal(
						yield* commands
							.start(
								actor,
								{ kind: "Refresh", connectionId: "connection" },
								Execution.CommandKey.make("while-cleaning"),
							)
							.pipe(Effect.flip),
						"_tag",
						"ExecutionConflict",
					)
					const nextCleanup = yield* store.takeOver(lateKey)
					assert.equal((yield* cleanup.claim(nextCleanup))._tag, "Revoke")
					assert.propertyVal(
						yield* cleanup.complete(lateFence).pipe(Effect.flip),
						"_tag",
						"ExecutionConflict",
					)
					assert.equal(
						(yield* db.select().from(appConnections))[0]?.executionId,
						lateKey.id,
					)
					const requests = yield* Ref.make(0)
					const runtime = CleanupWorkflow.layer.pipe(
						Layer.provideMerge(
							Layer.mergeAll(Calls.layer, Runner.layer, RunScope.layer),
						),
						Layer.provideMerge(Engine.layerRegistry),
						Layer.provideMerge(WorkflowEngine.layerMemory),
						Layer.provide(
							Layer.mock(Billing, {
								releaseExecution: () => Effect.succeed(true),
							}),
						),
						Layer.provideMerge(Observation.layer),
						Layer.provideMerge(Records.layer),
						Layer.provide(Layer.succeed(Cleanup.GrantCleanup, cleanup)),
						Layer.provide(
							Layer.succeed(
								AppNetwork,
								AppNetwork.of({
									layer: (networkOwner, origins) => {
										assert.equal(networkOwner, owner)
										assert.include(origins, "https://issuer.example")
										return Layer.mock(Network.Network, {
											identity: { scope: "user", owner: networkOwner },
											execute: (request) =>
												Effect.gen(function* () {
													assert.equal(
														request.url,
														"https://issuer.example/revoke",
													)
													assert.equal(request.method, "POST")
													const count = yield* Ref.updateAndGet(
														requests,
														(count) => count + 1,
													)
													return {
														url: request.url,
														status: count === 1 ? 503 : 200,
														headers: {},
														body: Stream.empty,
													}
												}),
										})
									},
								}),
							),
						),
					)
					yield* Ref.set(revoked, true)
					yield* Effect.gen(function* () {
						yield* CleanupWorkflow.workflow.execute(lateKey, { discard: true })
						yield* (yield* Observation.Observation)
							.observe(lateKey, 0)
							.pipe(Stream.runDrain)
						assert.equal((yield* store.get(lateKey)).status, "completed")
						assert.equal(yield* Ref.get(requests), 2)
						yield* CleanupWorkflow.workflow.execute(lateKey)
						assert.equal(yield* Ref.get(requests), 2)
					}).pipe(Effect.provide(runtime))
					yield* Ref.set(revoked, false)
					assert.equal(
						(yield* db.select().from(appConnections))[0]?.executionId,
						null,
					)
					assert.equal((yield* store.get(refreshKey)).status, "interrupted")
					yield* Connections.update(
						db,
						secrets,
						owner,
						"connection",
						(current) => ({
							...current,
							connection: {
								...current.connection,
								authorization: stored.connection.authorization,
							},
						}),
					)
					const shared = yield* commands.start(
						actor,
						{ kind: "Refresh", connectionId: "connection" },
						Execution.CommandKey.make("refresh-shared"),
					)
					const sharedKey = { namespace: owner, id: shared.executionId }
					const sharedFence = yield* store.takeOver(sharedKey)
					const sharedCall = yield* cleanup.writeAttempt(
						sharedFence,
						"refresh",
						{
							connectionId: "connection",
						},
						Cleanup.scopeOf(grant.credential),
					)
					yield* store.sending(sharedFence, sharedCall.id)
					yield* store.finishCall(
						sharedFence,
						sharedCall.id,
						yield* Schema.encodeEffect(
							Schema.toCodecJson(OAuthAuthorization.Grant),
						)({
							credential: {
								...grant.credential,
								accessToken: Redacted.make("shared-refresh-access"),
							},
						}),
						[],
						cleanup
							.enqueue(sharedFence, sharedCall.id, flow.metadata)
							.pipe(Effect.asVoid),
					)
					yield* commands.finish(sharedFence, { status: "interrupted" })
					const sharedReceipt = yield* cleanup.enqueue(
						sharedFence,
						sharedCall.id,
						flow.metadata,
					)
					const sharedCleanup = yield* store.takeOver({
						namespace: owner,
						id: sharedReceipt.executionId,
					})
					assert.equal((yield* cleanup.claim(sharedCleanup))._tag, "InUse")
					assert.equal((yield* store.get(sharedCleanup)).status, "running")
					// A new refresh token must stay owned even when the access token is reused.
					const partial = yield* commands.start(
						actor,
						{ kind: "Refresh", connectionId: "connection" },
						Execution.CommandKey.make("refresh-partial"),
					)
					const partialFence = yield* store.takeOver({
						namespace: owner,
						id: partial.executionId,
					})
					const partialCall = yield* cleanup.writeAttempt(
						partialFence,
						"refresh",
						{},
						Cleanup.scopeOf(grant.credential),
					)
					yield* store.sending(partialFence, partialCall.id)
					yield* store.finishCall(
						partialFence,
						partialCall.id,
						yield* Schema.encodeEffect(
							Schema.toCodecJson(OAuthAuthorization.Grant),
						)({
							credential: {
								...grant.credential,
								refreshToken: Redacted.make("rotated-refresh"),
							},
						}),
						[],
						cleanup
							.enqueue(partialFence, partialCall.id, flow.metadata)
							.pipe(Effect.asVoid),
					)
					yield* commands.finish(partialFence, { status: "interrupted" })
					const partialReceipt = yield* cleanup.enqueue(
						partialFence,
						partialCall.id,
						flow.metadata,
					)
					const partialCleanup = yield* store.takeOver({
						namespace: owner,
						id: partialReceipt.executionId,
					})
					assert.equal((yield* cleanup.claim(partialCleanup))._tag, "InUse")
					yield* store.commit(
						partialCleanup,
						{ status: "waiting" },
						Effect.void,
					)
					assert.equal((yield* store.get(partialCleanup)).status, "waiting")
					// Another local connection can hold the same remote grant.
					const otherOwner = Connections.ownerKey({ ...actor, userId: "other" })
					const otherCredential = {
						...grant.credential,
						binding: {
							...grant.credential.binding,
							owner: otherOwner,
							connectionId: "other-connection",
						},
					}
					const otherConnection = {
						...stored,
						connection: {
							...stored.connection,
							owner: otherOwner,
							connectionId: "other-connection",
							authorization: {
								_tag: "Authorized" as const,
								binding: otherCredential.binding,
								credentialRef: "other-reference",
								scopes: otherCredential.scopes,
							},
						},
					}
					yield* db.insert(appConnections).values({
						owner: otherOwner,
						id: "other-connection",
						name: otherConnection.name,
						revision: otherConnection.revision,
						body: yield* secrets.seal(
							yield* Schema.encodeEffect(
								Schema.fromJsonString(
									Schema.toCodecJson(Connections.StoredConnection),
								),
							)(otherConnection),
							yield* Schema.encodeEffect(
								Schema.fromJsonString(Schema.Array(Schema.String)),
							)(["connection", otherOwner, "other-connection"]),
						),
					})
					yield* db.insert(appSecrets).values({
						owner: otherOwner,
						id: "other-reference",
						connectionId: "other-connection",
						kind: "credential",
						body: yield* secrets.seal(
							yield* Schema.encodeEffect(
								Schema.fromJsonString(Schema.toCodecJson(Protocol.Credential)),
							)(otherCredential),
							yield* Schema.encodeEffect(
								Schema.fromJsonString(Schema.Array(Schema.String)),
							)(["credential", otherOwner, "other-reference"]),
						),
					})
					yield* Connections.update(
						db,
						secrets,
						owner,
						"connection",
						(current) => ({
							...current,
							connection: {
								...current.connection,
								authorization: { _tag: "Unprotected" },
							},
						}),
					)
					assert.equal((yield* cleanup.claim(sharedCleanup))._tag, "InUse")
					assert.equal((yield* cleanup.claim(partialCleanup))._tag, "InUse")
					yield* Connections.update(
						db,
						secrets,
						otherOwner,
						"other-connection",
						(current) => ({
							...current,
							connection: {
								...current.connection,
								authorization: { _tag: "Unprotected" },
							},
						}),
					)
					assert.equal((yield* cleanup.claim(sharedCleanup))._tag, "Revoke")
					assert.equal((yield* cleanup.claim(partialCleanup))._tag, "Wait")
					yield* cleanup.complete(sharedCleanup)
					assert.equal((yield* cleanup.claim(partialCleanup))._tag, "Revoke")
					yield* cleanup.complete(partialCleanup)
					assert.equal(
						(yield* db.select().from(appConnections))[0]?.executionId,
						null,
					)
					// Local removal owns all saved grants before it drops their references.
					yield* Connections.update(
						db,
						secrets,
						otherOwner,
						"other-connection",
						() => otherConnection,
					)
					const sharedRevoke = yield* commands.start(
						actor,
						{ kind: "Revoke", connectionId: "connection" },
						Execution.CommandKey.make("revoke-shared"),
					)
					const revokeFence = yield* store.takeOver({
						namespace: owner,
						id: sharedRevoke.executionId,
					})
					const beforeSecrets = (yield* db.select().from(appSecrets)).length
					const rollback = yield* sql
						.withTransaction(
							commands
								.commit(revokeFence, null)
								.pipe(Effect.andThen(Rollback.make({}))),
						)
						.pipe(Effect.flip)
					assert.equal(rollback._tag, "Rollback")
					assert.equal((yield* store.get(revokeFence)).status, "running")
					assert.equal(
						(yield* db.select().from(appSecrets)).length,
						beforeSecrets,
					)
					assert.deepEqual(
						(yield* commands.get(actor, sharedRevoke.executionId))
							.cleanupExecutions,
						[],
					)
					yield* commands.commit(revokeFence, null)
					const local = yield* commands.get(actor, sharedRevoke.executionId)
					assert.equal(local.execution.status, "completed")
					assert.equal(local.result?._tag, "RevocationPending")
					assert.isTrue(local.cleanupExecutions.length > 0)
					const detached = yield* Effect.forEach(
						local.cleanupExecutions,
						(execution) =>
							store.takeOver({ namespace: owner, id: execution.id }),
					)
					for (const fence of detached) {
						assert.equal((yield* cleanup.claim(fence))._tag, "InUse")
						const saved = yield* cleanup.load(fence)
						assert.isTrue(saved.detached)
						if (saved.detached) {
							const again = yield* cleanup.handoff(
								revokeFence,
								saved.ref.reference,
								saved.grant.credential,
							)
							assert.equal(again.executionId, fence.id)
						}
					}
					// The other owner can remove its reference without waiting on this cleanup.
					const otherActor = { ...actor, userId: "other" }
					const remove = yield* commands.start(
						otherActor,
						{ kind: "Remove", connectionId: "other-connection" },
						Execution.CommandKey.make("remove-shared"),
					)
					const removeFence = yield* store.takeOver({
						namespace: otherOwner,
						id: remove.executionId,
					})
					yield* commands.commit(removeFence, null)
					const removed = yield* commands.get(otherActor, remove.executionId)
					assert.equal(removed.result?._tag, "Removed")
					assert.equal(removed.cleanupExecutions.length, 1)
					assert.isTrue(Arr.isReadonlyArrayNonEmpty(removed.cleanupExecutions))
					if (!Arr.isReadonlyArrayNonEmpty(removed.cleanupExecutions)) return
					const otherCleanup = yield* store.takeOver({
						namespace: otherOwner,
						id: Arr.headNonEmpty(removed.cleanupExecutions).id,
					})
					for (const fence of [...detached, otherCleanup]) {
						assert.equal((yield* cleanup.claim(fence))._tag, "Revoke")
						const call = Arr.findFirst(
							yield* store.calls(fence),
							(call) => call.step === "revoke",
						)
						assert.isTrue(Option.isSome(call))
						if (Option.isSome(call)) {
							yield* store.sending(fence, call.value.id)
							yield* store.finishCall(fence, call.value.id, {
								_tag: "Completed",
								value: { _tag: "Revoked" },
							})
						}
						yield* cleanup.complete(fence)
					}
					assert.equal(
						(yield* commands.get(actor, sharedRevoke.executionId)).result?._tag,
						"Revoked",
					)
					assert.equal((yield* db.select().from(appConnections)).length, 1)
					assert.equal((yield* db.select().from(appSecrets)).length, 0)
					// A handoff must not wait on its source, which may wait for cleanup.
					const sourceReceipt = yield* commands.start(
						actor,
						{ kind: "Revoke", connectionId: "connection" },
						Execution.CommandKey.make("detached-source"),
					)
					const sourceFence = yield* store.takeOver({
						namespace: owner,
						id: sourceReceipt.executionId,
					})
					const noCycle = yield* sql.withTransaction(
						cleanup.handoff(sourceFence, "credential", grant.credential, {
							metadata: flow.metadata,
						}),
					)
					const noCycleFence = yield* store.takeOver({
						namespace: owner,
						id: noCycle.executionId,
					})
					assert.equal((yield* store.get(sourceFence)).status, "running")
					assert.equal((yield* cleanup.claim(noCycleFence))._tag, "Revoke")
					yield* cleanup.complete(noCycleFence)
					yield* commands.finish(sourceFence, { status: "interrupted" })
				}).pipe(
					Effect.provide(
						Commands.layer.pipe(
							Layer.provideMerge(Cleanup.layer),
							Layer.provide(auth),
							Layer.provide(
								Layer.mock(Governance, { check: () => Effect.void }),
							),
						),
					),
				)
			}),
	)
})
