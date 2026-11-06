import * as TestDatabase from "@openbot-build/server-database/Testing"
import { ConnectionId } from "@openbot-build/domain/ConnectionId"
import { IndexStore } from "@openbot-build/protocol"
import * as Migrations from "@openbot-build/server-database/Migrations"
import { NodeCrypto, NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { assert, layer } from "@effect/vitest"
import { Authorizer, Policy } from "@nmnmcc/ability"
import { ExecutionsApi } from "@openbot-build/api"
import { Authorization, Execution } from "@openbot-build/domain"
import {
	CatalogDiscovery,
	Discovery,
	Document,
	Network,
	PublicIndexing,
	RobotsPolicy,
} from "@openbot-build/protocol"
import {
	Cause,
	Effect,
	Layer,
	Logger,
	Redacted,
	References,
	Schema,
	String as Str,
} from "effect"
import * as Commands from "../src/ConnectionCommands.ts"
import * as AppInspections from "../src/AppInspections.ts"
import { AppNetwork } from "@openbot-build/apps-contract/apps/AppNetwork"
import { Governance } from "../src/Governance.ts"
import { GrantCleanup } from "../src/GrantCleanup.ts"
import * as Lifecycle from "../src/Lifecycle.ts"
import * as ManualConnection from "../src/ManualConnection.ts"
import { Probe } from "@openbot-build/apps-contract/apps/Probe"
import * as Stored from "@openbot-build/apps-contract/apps/StoredConnections"
import * as Db from "@openbot-build/server-database/Database"
import {
	appConnections,
	appRecords,
} from "@openbot-build/server-database/Schema"
import * as Records from "@openbot-build/server-kernel/Records"
import * as HttpErrors from "@openbot-build/server-execution/HttpErrors"
import * as Store from "@openbot-build/server-execution/Store"
import * as Secrets from "@openbot-build/server-kernel/Secrets"
import * as InstanceFixture from "./InstanceFixture.ts"

const database = Layer.effectDiscard(Migrations.migrate).pipe(
	Layer.provideMerge(
		Layer.unwrap(
			Effect.map(TestDatabase.start, (db) =>
				PgClient.layer({ url: Redacted.make(db.url) }),
			),
		),
	),
)
const services = Layer.merge(Store.layer, Records.layer).pipe(
	Layer.provideMerge(
		Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
	),
	Layer.provideMerge(database),
	Layer.provideMerge(InstanceFixture.layer),
	Layer.provideMerge(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
)
const actor = {
	kind: "member",
	organizationId: "lifecycle-org",
	userId: "lifecycle-user",
} as const
const owner = Stored.ownerKey(actor)
const manual = (id: string) => ({
	id: ConnectionId.make(id),
	name: "Test App",
	url: "https://app.example/mcp",
	transport: "streamable-http" as const,
	headers: {},
})
const seed = Effect.fn(function* (
	id: string,
	state: "Enabled" | "CleanupPending" = "Enabled",
) {
	const db = yield* Db.make
	const secrets = yield* Secrets.Secrets
	const configured = yield* ManualConnection.configure(owner)(manual(id))
	const connection: Stored.StoredConnection = {
		name: "Test App",
		revision: 0,
		verification: null,
		connection: { ...configured.connection, state },
	}
	yield* db.insert(appRecords).values({
		owner,
		cardUrl: configured.app.cardUrl,
		body: yield* Schema.encodeEffect(Stored.appCodec)(configured.app),
	})
	yield* db.insert(appConnections).values({
		owner,
		id,
		name: connection.name,
		revision: 0,
		body: yield* secrets.seal(
			yield* Schema.encodeEffect(
				Schema.fromJsonString(Schema.toCodecJson(Stored.StoredConnection)),
			)(connection),
			yield* Schema.encodeEffect(
				Schema.fromJsonString(Schema.Array(Schema.String)),
			)(["connection", owner, id]),
		),
	})
	return { app: configured.app, connection }
})
const collectLogs = () => {
	let lines: ReadonlyArray<unknown> = []
	return {
		lines: () => lines,
		layer: Logger.layer([
			Logger.make((log) => {
				lines = [
					...lines,
					{
						message: log.message,
						cause: Cause.pretty(log.cause),
						annotations: log.fiber.getRef(References.CurrentLogAnnotations),
					},
				]
			}),
		]),
	}
}
const commands = Commands.layer.pipe(
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
	Layer.provide(Layer.mock(GrantCleanup, {})),
)

layer(services, { excludeTestServices: true })((it) => {
	it.effect(
		"connection commands keep missing, invalid and cleanup errors before accepting work",
		() =>
			Effect.gen(function* () {
				const lifecycle = yield* Commands.ConnectionCommands
				const safe = yield* HttpErrors.make
				const sql = yield* PgClient.PgClient
				const start = (id: string, action: Commands.Action) =>
					lifecycle
						.start(actor, id, action, Execution.CommandKey.make(id))
						.pipe(safe, Effect.flip)
				const missing = yield* start("removed", { _tag: "Verify" })
				assert.propertyVal(missing, "_tag", "ExecutionNotFound")
				assert.propertyVal(missing, "id", "removed")
				yield* seed("cleanup", "CleanupPending")
				const pending = yield* start("cleanup", { _tag: "Verify" })
				assert.propertyVal(pending, "_tag", "ConnectionCleanupPending")
				assert.propertyVal(pending, "connectionId", "cleanup")
				assert.propertyVal(pending, "stage", "Connection")
				yield* seed("headers")
				const invalid = yield* start("headers", {
					_tag: "Manual",
					request: {
						...manual("headers"),
						revision: 0,
						headers: { "X-Account": null },
					},
				})
				assert.propertyVal(invalid, "_tag", "ConnectionConfigurationInvalid")
				assert.deepInclude(invalid, { keys: ["header:X-Account"] })
				const declaration = yield* ManualConnection.configure(owner)({
					...manual("bad-declaration"),
					url: "not a public address",
				}).pipe(Effect.flip)
				assert.equal(declaration._tag, "ConnectionConfigurationInvalid")
				assert.deepEqual(
					yield* sql`select id from openbot_executions where namespace = ${owner}`,
					[],
				)
				assert.deepEqual(
					yield* sql`select execution_id from openbot_app_connections where owner = ${owner} and execution_id is not null`,
					[],
				)
			}).pipe(Effect.provide(commands)),
	)

	it.effect(
		"a damaged connection stays a sealed storage error at the HTTP boundary",
		() =>
			Effect.gen(function* () {
				const lifecycle = yield* Commands.ConnectionCommands
				const safe = yield* HttpErrors.make
				const sql = yield* PgClient.PgClient
				const secrets = yield* Secrets.Secrets
				yield* seed("damaged")
				yield* sql`update openbot_app_connections set body = 'private-bad-connection' where owner = ${owner} and id = 'damaged'`
				const failure = yield* lifecycle
					.start(
						actor,
						"damaged",
						{ _tag: "Verify" },
						Execution.CommandKey.make("damaged"),
					)
					.pipe(safe, Effect.flip)
				assert.isTrue(Schema.is(ExecutionsApi.ExecutionUnavailable)(failure))
				if (!Schema.is(ExecutionsApi.ExecutionUnavailable)(failure)) return
				const body = yield* Schema.encodeEffect(
					Schema.fromJsonString(ExecutionsApi.ExecutionUnavailable),
				)(failure)
				assert.notMatch(body, /private-/)
				const rows = yield* sql<{
					readonly cause: string
				}>`select cause from openbot_execution_failures where id = ${failure.errorId}`
				assert.equal(rows.length, 1)
				assert.notMatch(rows[0]!.cause, /private-/)
				assert.include(
					yield* secrets.open(rows[0]!.cause, `failure:${failure.errorId}`),
					"SecretStorageError",
				)
				assert.deepEqual(
					yield* sql`select id from openbot_executions where namespace = ${owner}`,
					[],
				)
			}).pipe(Effect.provide(commands)),
	)

	it.effect(
		"a failed App check seals network details and returns a safe connection state",
		() => {
			const logs = collectLogs()
			return Effect.gen(function* () {
				const lifecycle = yield* Lifecycle.Lifecycle
				const sql = yield* PgClient.PgClient
				const secrets = yield* Secrets.Secrets
				const input = yield* seed("network")
				const executionId = Execution.Id.make("network-check")
				const result = yield* lifecycle.prepare(
					{
						...input,
						action: { _tag: "Verify" },
						credential: null,
						candidate: null,
					},
					executionId,
					Effect.void,
				)
				assert.propertyVal(
					result.connection.verification,
					"_tag",
					"ConnectionFailed",
				)
				assert.isNull(result.capabilities)
				assert.notMatch(
					yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
						logs.lines(),
					),
					/private-/,
				)
				assert.notMatch(
					yield* Schema.encodeEffect(
						Schema.fromJsonString(Commands.preparedCodec),
					)(result),
					/private-/,
				)
				const rows = yield* sql<{
					readonly id: string
					readonly cause: string
				}>`select id, cause from openbot_execution_failures where execution_id = ${executionId}`
				assert.equal(rows.length, 1)
				assert.notMatch(rows[0]!.cause, /private-/)
				assert.include(
					yield* secrets.open(rows[0]!.cause, `failure:${rows[0]!.id}`),
					"private-network-detail",
				)
			}).pipe(
				Effect.provide([
					logs.layer,
					Lifecycle.layer.pipe(
						Layer.provide(CatalogDiscovery.layerRules),
						Layer.provide(Layer.mock(Discovery.Discovery, {})),
						Layer.provide(Layer.mock(Probe, {})),
						Layer.provide(
							Layer.succeed(AppNetwork, {
								layer: () =>
									Layer.succeed(Network.Network, {
										identity: { scope: "user", owner },
										execute: () =>
											Effect.fail(
												Network.NetworkError.make({
													reason: "Timeout",
													message: "No answer",
													cause: new Error("private-network-detail"),
												}),
											),
										readDocument: () =>
											Effect.fail(
												Network.NetworkError.make({
													reason: "Timeout",
													message: "No answer",
													cause: new Error("private-network-detail"),
												}),
											),
									}),
							}),
						),
					),
				]),
			)
		},
	)
	it.effect(
		"an unconfirmed App publication keeps its private cause before returning a report",
		() => {
			const logs = collectLogs()
			return Effect.gen(function* () {
				const sql = yield* PgClient.PgClient
				const secrets = yield* Secrets.Secrets
				const cardUrl = "https://publication.example/card"
				const candidate = yield* Discovery.Candidate.decode({
					cardUrl,
					card: {
						$schema: Document.cardSchemaUrl,
						name: "test/app",
						version: "1.0.0",
						description: "Read a note.",
					},
					endpoints: [],
					sources: [],
				})
				const reports = AppInspections.layer.pipe(
					Layer.provide(
						Layer.mock(Discovery.Discovery, {
							resolve: () =>
								Effect.succeed({ _tag: "Single", candidate, issues: [] }),
						}),
					),
					Layer.provide(
						Layer.mock(IndexStore.IndexStore, {
							get: () => Effect.succeedNone,
						}),
					),
					Layer.provide(
						PublicIndexing.layerInspection.pipe(
							Layer.provide(CatalogDiscovery.layerRules),
							Layer.provide(RobotsPolicy.layer),
							Layer.provide(
								Layer.succeed(Network.PublicNetwork, {
									readDocument: () =>
										Effect.fail(
											Network.NetworkError.make({
												reason: "Transport",
												message: "private-publication-message",
												cause: new Error("private-publication-cause"),
											}),
										),
								}),
							),
						),
					),
				)
				const result = yield* AppInspections.AppInspections.use((service) =>
					service.inspect(cardUrl),
				).pipe(Effect.provide(reports))
				assert.equal(result.apps[0]?.eligibility._tag, "Unconfirmed")
				assert.notMatch(
					yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))([
						result,
						logs.lines(),
					]),
					/private-/,
				)
				const [saved] = yield* sql<{
					readonly id: string
					readonly cause: string
				}>`select id, cause from openbot_execution_failures where execution_id is null order by created_at desc limit 1`
				assert.isDefined(saved)
				assert.notMatch(saved!.cause, /private-/)
				const cause = yield* secrets.open(saved!.cause, `failure:${saved!.id}`)
				assert.include(cause, "private-publication-message")
				assert.include(cause, "private-publication-cause")
			}).pipe(Effect.provide(logs.layer))
		},
	)
})
