import * as IndexCommandsFixture from "./IndexCommandsFixture.ts"
import { IndexWork } from "../src/apps/IndexWork.ts"
import { assert, layer } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { ConnectionsApi as Api, Identity } from "@openbot-build/api"
import type { Caller } from "@openbot-build/domain"
import { Tokens } from "../src/auth/Tokens.ts"
import {
	AppConnections,
	CatalogDiscovery,
	Client,
	Discovery,
	Network,
	Store,
	Document,
} from "@openbot-build/protocol"
import {
	Array as Arr,
	Effect,
	Layer,
	Option,
	pipe,
	Record as Rec,
	Redacted,
	Ref,
	Schema,
	String as Str,
} from "effect"
import { SqlClient } from "effect/sql"
import * as Governance from "../src/apps/Governance.ts"
import * as OrganizationFixture from "./OrganizationFixture.ts"
import * as Connections from "../src/apps/Connections.ts"
import * as AppHost from "../src/apps/AppHost.ts"
import * as ProtocolStores from "../src/apps/ProtocolStores.ts"
import { Probe } from "../src/apps/Probe.ts"
import { eq } from "drizzle-orm"
import { appRecords } from "../src/database/Schema.ts"
import * as StoredConnections from "../src/apps/StoredConnections.ts"
import { ownerKey } from "../src/apps/StoredConnections.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import * as Database from "../src/database/DatabasePostgres.ts"
import * as Postgres from "./PostgresTest.ts"
import * as Fixture from "./AppFixture.ts"
import * as BrowserHost from "./BrowserHost.ts"
import * as Db from "../src/database/Database.ts"

const encryptionKey = Redacted.make("test:" + Str.repeat(32)("11"))
const alice: Caller = {
	kind: "member",
	organizationId: "organization",
	userId: "alice",
}
const bob: Caller = {
	kind: "member",
	organizationId: "organization",
	userId: "bob",
}
const asOwner = <A, E, R>(operation: Effect.Effect<A, E, R>, owner = alice) =>
	Effect.provideService(operation, Identity, owner)
const toJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

layer(BrowserHost.layerPlatform, { excludeTestServices: true })((it) => {
	it.effect("App checks and saves the same card after one refresh", () =>
		Effect.gen(function* () {
			const database = yield* Postgres.start
			const publisher = yield* Fixture.start()
			const source = yield* Discovery.Discovery.pipe(
				Effect.provide(publisher.discovery),
			)
			const refreshes = yield* Ref.make(0)
			const checked = yield* Ref.make(Option.none<Store.UserConnection>())
			const discovery = Layer.succeed(Discovery.Discovery, {
				...source,
				refreshCard: (url) =>
					Ref.update(refreshes, (count) => count + 1).pipe(
						Effect.andThen(source.refreshCard(url)),
					),
			})
			const app = AppHost.layer.pipe(
				Layer.provide(ProtocolStores.layer),
				Layer.provide(IndexCommandsFixture.layer),
				Layer.provide(discovery),
				Layer.provide(CatalogDiscovery.layerRules),
				Layer.provide(AppConnections.layerConnectionScopes),
				Layer.provide(
					Layer.succeed(AppHost.AppNetwork, {
						layer: () =>
							Layer.effect(
								Network.Network,
								Effect.die("This test has no App network."),
							),
					}),
				),
				Layer.provide(
					Layer.succeed(Probe, {
						check: ({ connection }) =>
							Ref.set(checked, Option.some(connection)).pipe(
								Effect.andThen(publisher.changeCard),
								Effect.as({ requiresAuthorization: false } as const),
							),
					}),
				),
				Layer.provide(
					Governance.layer.pipe(
						Layer.provide(OrganizationFixture.layerDefaultSettings),
					),
				),
				Layer.provide(Secrets.layer(encryptionKey)),
				Layer.provideMerge(
					Database.layer({ databaseUrl: Redacted.make(database.url) }),
				),
				Layer.provide(NodeServices.layer),
			)
			yield* Effect.gen(function* () {
				yield* Database.migrate
				const host = (yield* AppHost.AppHost).bind(
					ownerKey(alice),
					Client.InvocationPolicy.of({ check: () => Effect.void }),
				)
				const result = yield* host.discover(publisher.origin + "/card")
				assert.strictEqual(result._tag, "Single")
				if (result._tag !== "Single") return
				const saved = yield* host.add({
					key: { owner: ownerKey(alice), connectionId: "checked" },
					candidate: result.candidate,
					remoteIndex: 0,
					values: {
						"header:X-Account": "Work",
						"header:X-Secret": "private-app-token",
					},
					confirmed: true,
					requiresAuthorization: true,
				})
				assert.strictEqual(yield* Ref.get(refreshes), 1)
				assert.deepStrictEqual(
					yield* Ref.get(checked),
					Option.some(saved.connection),
				)
				assert.deepStrictEqual(
					yield* host.getConnection(saved.connection),
					saved.connection,
				)
			}).pipe(Effect.provide(app))
		}),
	)

	it.effect(
		"confirmed App connections save encrypted configuration, reject changes, and keep accounts apart",
		() =>
			Effect.gen(function* () {
				const database = yield* Postgres.start
				const publisher = yield* Fixture.start()
				const storage = Layer.merge(
					Secrets.layer(encryptionKey),
					Database.layer({ databaseUrl: Redacted.make(database.url) }),
				).pipe(Layer.provide(NodeServices.layer))
				const app = Connections.layer.pipe(
					Layer.provide(
						OrganizationFixture.layerAuthorization.pipe(
							Layer.provide(Layer.mock(Tokens, {})),
						),
					),
					Layer.provide(IndexCommandsFixture.layer),
					Layer.provide(publisher.discovery),
					Layer.provide(CatalogDiscovery.layerRules),
					Layer.provide(publisher.probe),
					Layer.provide(
						Governance.layer.pipe(
							Layer.provide(OrganizationFixture.layerDefaultSettings),
						),
					),
					Layer.provide(NodeServices.layer),
					Layer.provideMerge(storage),
				)
				const id = yield* Effect.gen(function* () {
					yield* Database.migrate
					const sql = yield* SqlClient.SqlClient
					const connections = yield* Connections.Connections
					const draft = yield* asOwner(
						connections.prepareConnection(
							publisher.origin + "/catalog?account=private-catalog-input",
						),
					)
					assert.strictEqual(draft.discovery._tag, "Multiple")
					assert.deepStrictEqual(
						yield* asOwner(connections.listConnections),
						[],
					)
					assert.strictEqual(
						(yield* Effect.flip(
							asOwner(connections.getConnectionDraft(draft.id), bob),
						))._tag,
						"ExperienceNotFound",
					)
					const input: Api.ConnectionRequest = {
						draftId: draft.id,
						revision: draft.revision,
						cardUrl: publisher.origin + "/card?edition=team",
						remoteIndex: 0,
						name: "  Project documents  ",
						values: {
							"header:X-Account": "Work",
							"header:X-Secret": "private-app-token",
						},
						confirmed: true,
					}
					assert.strictEqual(
						(yield* Effect.flip(
							asOwner(connections.createConnection({ ...input, values: {} })),
						))._tag,
						"ConnectionConfigurationInvalid",
					)
					// Only the field that is missing comes back, not every field.
					const partial = yield* Effect.flip(
						asOwner(
							connections.createConnection({
								...input,
								values: { "header:X-Account": "Work" },
							}),
						),
					)
					assert.strictEqual(partial._tag, "ConnectionConfigurationInvalid")
					if (partial._tag === "ConnectionConfigurationInvalid")
						assert.deepStrictEqual(partial.keys, ["header:X-Secret"])
					const saved = yield* asOwner(connections.createConnection(input))
					assert.strictEqual(saved.name, "Project documents")
					assert.strictEqual(saved.availability._tag, "Unverified")
					assert.deepStrictEqual(saved.configuration, {
						"header:X-Account": "Work",
					})
					assert.strictEqual(
						Str.includes("private-app-token")(yield* toJson(saved)),
						false,
					)
					const duplicates = yield* Effect.all(
						[
							asOwner(connections.createConnection(input)),
							asOwner(connections.createConnection(input)),
						],
						{ concurrency: 2 },
					)
					assert.strictEqual(duplicates[0].id, saved.id)
					assert.strictEqual(duplicates[1].id, saved.id)
					const rows = yield* sql<{
						readonly body: string
					}>`SELECT body FROM openbot_app_connections`
					assert.strictEqual(rows.length, 1)
					assert.strictEqual(
						Arr.some(rows, (row) =>
							Str.includes("private-app-token")(row.body),
						),
						false,
					)
					const jobs = yield* sql`SELECT * FROM openbot_app_index_jobs`
					assert.strictEqual(jobs.length, 1)
					const publicData = pipe(
						jobs,
						Arr.flatMap((row) => Arr.map(Rec.values(row), String)),
						Arr.join(" "),
					)
					assert.strictEqual(
						Str.includes("private-app-token")(publicData),
						false,
					)
					assert.strictEqual(
						Str.includes("private-catalog-input")(publicData),
						false,
					)
					assert.strictEqual(
						Option.exists(Arr.head(jobs), (job) =>
							Arr.contains(Rec.keys(job), "owner"),
						),
						false,
					)
					assert.strictEqual(
						(yield* Effect.flip(
							asOwner(connections.getConnection(saved.id), bob),
						))._tag,
						"ExperienceNotFound",
					)
					const changed = yield* asOwner(
						connections.prepareConnection(
							publisher.origin + "/card?edition=team",
						),
					)
					yield* publisher.changeCard
					const failure = yield* Effect.flip(
						asOwner(
							connections.createConnection({ ...input, draftId: changed.id }),
						),
					)
					assert.strictEqual(failure._tag, "ConnectionConflict")
					const expired = { ...draft, id: "expired", expiresAt: 0 }
					const db = yield* Db.make
					yield* StoredConnections.saveDraft(db, ownerKey(alice), expired)
					const expiredResult = yield* Effect.flip(
						asOwner(
							connections.createConnection({ ...input, draftId: expired.id }),
						),
					)
					assert.strictEqual(expiredResult._tag, "ConnectionConflict")
					const bobDraft = yield* asOwner(
						connections.prepareConnection(
							publisher.origin + "/card?edition=team",
						),
						bob,
					)
					yield* sql.unsafe(
						"CREATE FUNCTION reject_app_connection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'App connection storage unavailable'; END $$",
					)
					yield* sql.unsafe(
						"CREATE TRIGGER reject_app_connection BEFORE INSERT ON openbot_app_connections FOR EACH ROW EXECUTE FUNCTION reject_app_connection()",
					)
					assert.strictEqual(
						(yield* Effect.flip(
							asOwner(
								connections.createConnection({
									...input,
									draftId: bobDraft.id,
								}),
								bob,
							),
						))._tag,
						"ExperienceStorageUnavailable",
					)
					yield* sql.unsafe(
						"DROP TRIGGER reject_app_connection ON openbot_app_connections",
					)
					yield* sql.unsafe("DROP FUNCTION reject_app_connection()")
					assert.deepStrictEqual(
						yield* db
							.select()
							.from(appRecords)
							.where(eq(appRecords.owner, ownerKey(bob))),
						[],
					)
					assert.deepStrictEqual(
						yield* asOwner(connections.listConnections, bob),
						[],
					)
					yield* sql.unsafe(
						"CREATE FUNCTION reject_index_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Index work storage unavailable'; END $$",
					)
					yield* sql.unsafe(
						"CREATE TRIGGER reject_index_job BEFORE INSERT ON openbot_app_index_jobs FOR EACH ROW EXECUTE FUNCTION reject_index_job()",
					)
					assert.strictEqual(
						(yield* Effect.flip(
							asOwner(
								connections.createConnection({
									...input,
									draftId: bobDraft.id,
								}),
								bob,
							),
						))._tag,
						"ExperienceStorageUnavailable",
					)
					yield* sql.unsafe(
						"DROP TRIGGER reject_index_job ON openbot_app_index_jobs",
					)
					yield* sql.unsafe("DROP FUNCTION reject_index_job()")
					assert.deepStrictEqual(
						yield* db
							.select()
							.from(appRecords)
							.where(eq(appRecords.owner, ownerKey(bob))),
						[],
					)
					assert.deepStrictEqual(
						yield* asOwner(connections.listConnections, bob),
						[],
					)
					return saved.id
				}).pipe(Effect.provide(app, { local: true }))
				// A second build of the same Layers acts as a restart on the same database.
				yield* Effect.gen(function* () {
					const connections = yield* Connections.Connections
					assert.strictEqual(
						(yield* asOwner(connections.getConnection(id))).enabled,
						true,
					)
					const db = yield* Db.make
					const secrets = yield* Secrets.Secrets
					assert.strictEqual(
						Redacted.value(
							(yield* StoredConnections.get(db, secrets, ownerKey(alice), id))
								.connection.configuration,
						)["header:X-Secret"],
						"private-app-token",
					)
				}).pipe(Effect.provide(app, { local: true }))
			}),
	)

	it.effect(
		"connection limits stay atomic across concurrent database pools and storage failures stay failures",
		() =>
			Effect.gen(function* () {
				const database = yield* Postgres.start
				const storage = () =>
					IndexCommandsFixture.layer.pipe(
						Layer.provideMerge(
							Layer.merge(
								Secrets.layer(encryptionKey),
								Database.layer({ databaseUrl: Redacted.make(database.url) }),
							),
						),
						Layer.provide(NodeServices.layer),
					)
				// Each build has its own database pool.
				const first = yield* Layer.build(storage())
				const second = yield* Layer.build(storage())
				yield* Effect.provideContext(Database.migrate, first)
				const save = (services: typeof first, id: string) =>
					Effect.gen(function* () {
						const db = yield* Db.make
						const secrets = yield* Secrets.Secrets
						const connection = yield* Store.UserConnection.decode({
							owner: ownerKey(alice),
							connectionId: id,
							cardUrl: "https://example.test/card",
							endpoint: "https://example.test/mcp",
							remoteIndex: 0,
							configuration: Redacted.make({}),
							headers: Redacted.make({}),
							state: "Enabled",
							authorization: { _tag: "Unprotected" },
						})
						const app = yield* Store.AppRecord.decode({
							cardUrl: connection.cardUrl,
							card: {
								$schema: Document.cardSchemaUrl,
								name: "example.test/app",
								version: "1.0.0",
								description: "Fixture",
								remotes: [
									{
										type: "streamable-http",
										url: connection.endpoint,
										supportedProtocolVersions: ["2026-07-28"],
									},
								],
							},
							sources: [],
						})
						return yield* StoredConnections.save(
							db,
							secrets,
							yield* IndexWork,
							ownerKey(alice),
							{ app, connection, name: id },
						).pipe(Effect.result)
					}).pipe(Effect.provideContext(services))
				const results = yield* Effect.all(
					Arr.makeBy(35, (index) =>
						save(index % 2 === 0 ? first : second, String(index)),
					),
					{ concurrency: "unbounded" },
				)
				assert.strictEqual(Arr.getSuccesses(results).length, 30)
				assert.deepStrictEqual<ReadonlyArray<string>>(
					Arr.map(Arr.getFailures(results), (failure) =>
						failure._tag === "ConnectionConflict"
							? failure.reason
							: failure._tag,
					),
					Arr.replicate("LimitReached", 5),
				)
			}),
	)
})
