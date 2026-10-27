import * as Imported from "../src/database/conversion/Executions.ts"
import * as Legacy from "../src/database/conversion/LegacyV1.ts"
import * as Authority from "../src/database/conversion/Authority.ts"
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
	Authorization as OAuth,
	OAuthAuthorization,
	Store as ProtocolStore,
} from "@openbot-build/protocol"
import {
	Array as Arr,
	Clock,
	Effect,
	Fiber,
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
import * as Commands from "../src/apps/TestCommands.ts"
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
	tokenId: TokenId.make("test-token"),
} as const
layer(services, { excludeTestServices: true })((it) => {
	it.effect(
		"test commands keep one run, its caller, and its current owner",
		() =>
			Effect.gen(function* () {
				const denied = yield* Ref.make(false)
				const auth = Authorizer.layer(Authorization.Auth, {
					policy: (caller) =>
						Ref.get(denied).pipe(
							Effect.map((deny) =>
								Policy.define(Authorization.OpenBot)(function* (_) {
									yield* _.allow("*", "*")
									if (deny && caller.kind === "user_token")
										yield* _.deny("publish", Authorization.App)
								}),
							),
						),
				})
				yield* Effect.gen(function* () {
					const commands = yield* Commands.TestCommands
					const store = yield* Store.Store
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
					const make = (id: string) =>
						Rows.putTest(db, "public", {
							owner,
							resourceMetadataUrl: null,
							value: {
								id,
								cardUrl: candidate.cardUrl,
								candidate,
								remoteIndex: 0,
								endpoint: "https://test.example/mcp",
								configurationKeys: [],
								issuers: [],
								requestedScopes: [],
								createdAt: now,
								expiresAt: now + 3600000,
								status: "Queued",
								checkedAt: null,
								cleanup: "NotRequired",
								cleanupRemote: "NotRequired",
								cleanupLocal: "Pending",
								authorization: null,
								stages: [],
								reason: null,
							},
						})
					yield* make("test")
					yield* make("other")
					const key = Execution.CommandKey.make("run-one")
					const receipts = yield* Effect.all(
						Arr.makeBy(8, () => commands.request(actor, "test", key)),
						{ concurrency: "unbounded" },
					)
					const receipt = receipts[0]!
					assert.isTrue(
						Arr.every(
							receipts,
							(value) => value.executionId === receipt.executionId,
						),
					)
					assert.strictEqual(
						(yield* Rows.getTest(db, "public", "test")).value.executionId,
						receipt.executionId,
					)
					assert.propertyVal(
						yield* commands.request(actor, "other", key).pipe(Effect.flip),
						"_tag",
						"ExecutionKeyConflict",
					)
					assert.propertyVal(
						yield* commands
							.request(actor, "test", Execution.CommandKey.make("run-two"))
							.pipe(Effect.flip),
						"reason",
						"TestBusy",
					)
					assert.propertyVal(
						yield* commands
							.request({ ...actor, userId: "other" }, "test", key)
							.pipe(Effect.flip),
						"_tag",
						"DeveloperNotFound",
					)
					const execution = { namespace: owner, id: receipt.executionId }
					assert.deepEqual(
						(yield* store.loadMember(execution)).identity.actor,
						actor,
					)
					const first = yield* store.takeOver(execution)
					const second = yield* store.takeOver(execution)
					const stages = [
						{ name: "negotiation", status: "Passed", items: [], reason: null },
					] as const
					assert.propertyVal(
						yield* commands.progress(first, stages).pipe(Effect.flip),
						"_tag",
						"ExecutionConflict",
					)
					yield* commands.progress(second, stages)
					assert.deepEqual(
						(yield* Rows.getTest(db, "public", "test")).value.stages,
						stages,
					)
					assert.propertyVal(
						yield* commands
							.authorize(
								second,
								{ ...actor, tokenId: TokenId.make("another-token") },
								"advance",
							)
							.pipe(Effect.flip),
						"_tag",
						"ExecutionForbidden",
					)
					yield* Ref.set(denied, true)
					assert.propertyVal(
						yield* commands.progress(second, []).pipe(Effect.flip),
						"_tag",
						"ExecutionForbidden",
					)
					yield* Ref.set(denied, false)
					yield* store.cancel(
						execution,
						Execution.CommandKey.make("cancel"),
						actor,
					)
					assert.propertyVal(
						yield* commands
							.complete(second, { _tag: "Completed", stages })
							.pipe(Effect.flip),
						"_tag",
						"ExecutionConflict",
					)
					const cancelled = yield* store.load(execution)
					yield* commands.finish(second, {
						status: "cancelled",
						epoch: cancelled.cancelEpoch,
					})
					assert.strictEqual((yield* store.get(execution)).status, "cancelled")
					assert.strictEqual(
						(yield* Rows.getTest(db, "public", "test")).value.status,
						"Cancelled",
					)
					yield* commands.stop(owner, "test")
					yield* make("imported")
					const importer = yield* Imported.make
					const oldKey = yield* sql.withTransaction(
						importer.write({
							namespace: owner,
							collection: "developer-test",
							sourceKey: "imported",
							resource: { kind: "DeveloperTest", id: "imported" },
							input: {
								_tag: "Imported",
								format: 1,
								source: Legacy.source,
								owner: {
									organizationId: actor.organizationId,
									userId: actor.userId,
								},
								authority: Authority.missing(actor),
								reason: "OutsideResultUnknown",
								history: {},
							},
							status: "outcome_unknown",
							createdAt: now,
							updatedAt: now,
							calls: [
								{
									step: "redeem",
									attempt: 1,
									status: "outcome_unknown",
									input: {},
									result: null,
								},
							],
						}),
					)
					const oldTest = yield* Rows.getTest(db, "public", "imported")
					yield* Rows.putTest(db, "public", {
						...oldTest,
						value: { ...oldTest.value, executionId: oldKey.id },
					})
					const stopped = yield* Ref.make(false)
					const waiting = yield* commands
						.stop(owner, "imported")
						.pipe(Effect.ensuring(Ref.set(stopped, true)), Effect.forkScoped)
					yield* Effect.sleep("50 millis")
					assert.isFalse(yield* Ref.get(stopped))
					const unknown = yield* store.load(oldKey)
					assert.equal(unknown.record.status, "outcome_unknown")
					assert.equal(unknown.cancelPending, false)
					yield* store.transition(
						{ ...oldKey, generation: unknown.generation },
						"interrupted",
						unknown.record.failure!,
					)
					yield* Fiber.join(waiting)
					yield* commands.stop(owner, "imported")

					yield* make("prepare")
					const record = yield* Rows.getTest(db, "public", "prepare")
					yield* Rows.putTest(db, "public", {
						...record,
						value: {
							...record.value,
							status: "AwaitingAuthorization",
							issuers: ["https://issuer.example"],
						},
					})
					const stores = yield* TestStores.DeveloperTestStores
					const connection = yield* ProtocolStore.UserConnection.decode({
						owner,
						connectionId: "prepare",
						cardUrl: candidate.cardUrl,
						endpoint: "https://test.example/mcp",
						remoteIndex: 0,
						configuration: Redacted.make({}),
						headers: Redacted.make({}),
						state: "Enabled",
						authorization: { _tag: "Unprotected" },
					})
					yield* stores.bind(owner, "prepare").apps.save({
						app: ProtocolStore.AppRecord.make(candidate),
						connection,
					})
					const preparationKey = Execution.CommandKey.make("prepare-one")
					const preparedReceipt = yield* commands.prepare(
						actor,
						"prepare",
						{ scopes: [] },
						preparationKey,
					)
					assert.deepEqual(
						yield* commands.prepare(
							actor,
							"prepare",
							{ scopes: [] },
							preparationKey,
						),
						preparedReceipt,
					)
					assert.strictEqual(
						(yield* Rows.getTest(db, "public", "prepare")).value.authorization,
						null,
					)
					assert.propertyVal(
						yield* commands
							.request(
								actor,
								"prepare",
								Execution.CommandKey.make("run-during-prepare"),
							)
							.pipe(Effect.flip),
						"reason",
						"TestBusy",
					)
					const preparation = {
						namespace: owner,
						id: preparedReceipt.executionId,
					}
					const old = yield* store.takeOver(preparation)
					const current = yield* store.takeOver(preparation)
					const flow = OAuth.Flow.make({
						flowId: "prepared-flow",
						binding: {
							owner,
							connectionId: "prepare",
							issuer: "https://issuer.example",
							resource: connection.endpoint,
						},
						clientId: "https://openbot.example/client",
						redirectUri: "https://openbot.example/callback",
						scopes: [],
						verifier: Redacted.make("private-test-verifier"),
						expiresAt: now + 600000,
						metadata: OAuth.ServerMetadata.make({
							issuer: "https://issuer.example",
							authorization_endpoint: "https://issuer.example/authorize",
							token_endpoint: "https://issuer.example/token",
							code_challenge_methods_supported: ["S256"],
							response_types_supported: ["code"],
						}),
					})
					const prepared = {
						flow,
						authorizationUrl:
							"https://issuer.example/authorize?state=prepared-flow",
					}
					assert.propertyVal(
						yield* commands.prepared(old, prepared).pipe(Effect.flip),
						"_tag",
						"ExecutionConflict",
					)
					assert.propertyVal(
						yield* Rows.getFlow(db, "public", flow.flowId).pipe(Effect.flip),
						"_tag",
						"DeveloperNotFound",
					)
					yield* Ref.set(denied, true)
					assert.propertyVal(
						yield* commands.prepared(current, prepared).pipe(Effect.flip),
						"_tag",
						"ExecutionForbidden",
					)
					yield* Ref.set(denied, false)
					yield* commands.prepared(current, prepared)
					const ready = yield* Rows.getTest(db, "public", "prepare")
					assert.strictEqual(ready.value.status, "AwaitingAuthorization")
					assert.strictEqual(
						ready.value.authorization?.authorizationUrl,
						prepared.authorizationUrl,
					)
					assert.strictEqual(
						(yield* store.get(preparation)).status,
						"completed",
					)
					const storedFlow = yield* Rows.getFlow(db, "public", flow.flowId)
					assert.isNotNull(storedFlow.body)
					assert.notInclude(storedFlow.body ?? "", "private-test-verifier")
					assert.strictEqual(
						(yield* stores
							.bind(owner, "prepare")
							.flows.get({ key: connection, flowId: flow.flowId })).flowId,
						flow.flowId,
					)
					const secrets = yield* Secrets.Secrets
					const received = { ...storedFlow.value, status: "Received" as const }
					yield* Rows.putFlow(db, "public", {
						...storedFlow,
						value: received,
						callback: yield* secrets.seal(
							"https://openbot.example/callback?state=prepared-flow&code=private-code",
							yield* Commands.callbackBinding(owner, "prepare", flow.flowId),
						),
					})
					yield* Rows.putTest(db, "public", {
						...ready,
						value: { ...ready.value, authorization: received },
					})
					const member = {
						kind: "member",
						organizationId: actor.organizationId,
						userId: actor.userId,
					} as const
					const exchangeKey = Execution.CommandKey.make("exchange-one")
					const exchangeReceipt = yield* commands.exchange(
						member,
						"prepare",
						exchangeKey,
					)
					assert.deepEqual(
						yield* commands.exchange(member, "prepare", exchangeKey),
						exchangeReceipt,
					)
					const exchange = { namespace: owner, id: exchangeReceipt.executionId }
					assert.deepEqual(
						(yield* store.loadMember(exchange)).identity.constraints,
						[actor],
					)
					assert.equal(
						(yield* Rows.getTest(db, "public", "prepare")).value.status,
						"ExchangingAuthorization",
					)
					assert.isTrue(
						(yield* Rows.getFlow(db, "public", flow.flowId)).consumed,
					)
					const raw = yield* sql<{
						input: string
					}>`select input from openbot_executions where id=${exchangeReceipt.executionId}`
					assert.notInclude(raw[0]!.input, "private-code")
					assert.notInclude(raw[0]!.input, "private-test-verifier")
					const firstExchange = yield* store.takeOver(exchange)
					const nextExchange = yield* store.takeOver(exchange)
					const grant = {
						credential: ProtocolStore.Credential.make({
							binding: flow.binding,
							clientId: flow.clientId,
							scopes: [],
							accessToken: Redacted.make("private-grant"),
						}),
					}
					const grantCall = yield* store.writeAttempt(
						nextExchange,
						"exchange",
						{ flowId: flow.flowId },
					)
					yield* store.sending(nextExchange, grantCall.id)
					yield* store.finishCall(
						nextExchange,
						grantCall.id,
						yield* Schema.encodeEffect(
							Schema.toCodecJson(OAuthAuthorization.Grant),
						)(grant),
					)
					assert.propertyVal(
						yield* commands
							.exchanged(firstExchange, grantCall.id, grant)
							.pipe(Effect.flip),
						"_tag",
						"ExecutionConflict",
					)
					yield* Ref.set(denied, true)
					assert.propertyVal(
						yield* commands
							.exchanged(nextExchange, grantCall.id, grant)
							.pipe(Effect.flip),
						"_tag",
						"ExecutionForbidden",
					)
					yield* Ref.set(denied, false)
					yield* commands.exchanged(nextExchange, grantCall.id, grant)
					const authorized = yield* stores
						.bind(owner, "prepare")
						.apps.get(connection)
					assert.equal(authorized.authorization._tag, "Authorized")
					assert.equal((yield* store.get(exchange)).status, "completed")
					assert.equal(
						(yield* Rows.getTest(db, "public", "prepare")).value.status,
						"Queued",
					)
					assert.isNull((yield* Rows.getFlow(db, "public", flow.flowId)).body)
					assert.isTrue(
						Arr.some(yield* store.events(exchange, 0), (event) =>
							Schema.toEquivalence(Execution.EventBody)(
								event.body,
								GrantCleanup.installed(grantCall.id),
							),
						),
					)
				}).pipe(
					Effect.provide(
						Commands.layer.pipe(
							Layer.provideMerge(GrantCleanup.layer),
							Layer.provideMerge(
								TestStores.layer.pipe(
									Layer.provide(
										Secrets.layer(
											Redacted.make("test:" + Str.repeat(32)("11")),
										),
									),
								),
							),
							Layer.provide(auth),
							Layer.provide(
								Layer.mock(DeveloperAccess, {
									authorize: () => Effect.succeed([]),
								}),
							),
						),
					),
				)
			}),
	)
})
