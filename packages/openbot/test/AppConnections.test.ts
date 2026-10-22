// @effect-diagnostics strictEffectProvide:off
import assert from "node:assert/strict"
import { test } from "node:test"
import { NodeServices } from "@effect/platform-node"
import { ConnectionsApi as Api, Identity, AuthApi } from "@openbot-build/api"
import { CatalogDiscovery, Store, Document } from "@openbot-build/protocol"
import { Effect, Layer, ManagedRuntime, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import * as Governance from "../src/apps/Governance.ts"
import * as OrganizationFixture from "./OrganizationFixture.ts"
import * as Connections from "../src/apps/Connections.ts"
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

const encryptionKey = Redacted.make("test:" + "11".repeat(32))
const alice = { organizationId: "organization", userId: "alice" }
const bob = { organizationId: "organization", userId: "bob" }
const asOwner = <A, E, R>(operation: Effect.Effect<A, E, R>, owner = alice) =>
	Effect.provideService(operation, Identity, owner)

test("confirmed App connections save encrypted configuration, reject changes, and keep accounts apart", async () => {
	const database = await Postgres.start()
	const publisher = await Fixture.start()
	const storage = Layer.merge(
		Secrets.layer(encryptionKey),
		Database.layer({ databaseUrl: Redacted.make(database.url) }),
	).pipe(Layer.provide(NodeServices.layer))
	const makeRuntime = () =>
		ManagedRuntime.make(
			Connections.layer.pipe(
				Layer.provide(publisher.discovery),
				Layer.provide(CatalogDiscovery.layerRules),
				Layer.provide(publisher.probe),
				Layer.provide(
					Governance.layer.pipe(
						Layer.provide(OrganizationFixture.layerDefaultSettings),
					),
				),
				Layer.provideMerge(storage),
			),
		)
	let runtime = makeRuntime()
	try {
		const id = await runtime.runPromise(
			Effect.gen(function* () {
				yield* Database.migrate
				const sql = yield* SqlClient.SqlClient
				const connections = yield* Connections.Connections
				const draft = yield* asOwner(
					connections.prepareConnection(
						publisher.origin + "/catalog?account=private-catalog-input",
					),
				)
				assert.equal(draft.discovery._tag, "Multiple")
				assert.deepEqual(yield* asOwner(connections.listConnections), [])
				assert.equal(
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
				assert.equal(
					(yield* Effect.flip(
						asOwner(connections.createConnection({ ...input, values: {} })),
					))._tag,
					"ConnectionConfigurationInvalid",
				)
				const saved = yield* asOwner(connections.createConnection(input))
				assert.equal(saved.name, "Project documents")
				assert.equal(saved.availability._tag, "Unverified")
				assert.deepEqual(saved.configuration, { "header:X-Account": "Work" })
				assert.equal(JSON.stringify(saved).includes("private-app-token"), false)
				const duplicates = yield* Effect.all(
					[
						asOwner(connections.createConnection(input)),
						asOwner(connections.createConnection(input)),
					],
					{ concurrency: 2 },
				)
				assert.equal(duplicates[0].id, saved.id)
				assert.equal(duplicates[1].id, saved.id)
				const rows = yield* sql<{
					readonly body: string
				}>`SELECT body FROM openbot_app_connections`
				assert.equal(rows.length, 1)
				assert.equal(rows[0]?.body.includes("private-app-token"), false)
				const jobs = yield* sql`SELECT * FROM openbot_app_index_jobs`
				assert.equal(jobs.length, 1)
				const publicData = jobs
					.flatMap((row) => Object.values(row).map(String))
					.join(" ")
				assert.equal(publicData.includes("private-app-token"), false)
				assert.equal(publicData.includes("private-catalog-input"), false)
				assert.equal(Object.keys(jobs[0] ?? {}).includes("owner"), false)
				assert.equal(
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
				publisher.changeCard()
				const failure = yield* Effect.flip(
					asOwner(
						connections.createConnection({ ...input, draftId: changed.id }),
					),
				)
				assert.equal(failure._tag, "ConnectionConflict")
				const expired = { ...draft, id: "expired", expiresAt: 0 }
				const db = yield* Db.make
				yield* StoredConnections.saveDraft(db, ownerKey(alice), expired)
				const expiredResult = yield* Effect.flip(
					asOwner(
						connections.createConnection({ ...input, draftId: expired.id }),
					),
				)
				assert.equal(expiredResult._tag, "ConnectionConflict")
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
				assert.equal(
					(yield* Effect.flip(
						asOwner(
							connections.createConnection({ ...input, draftId: bobDraft.id }),
							bob,
						),
					))._tag,
					"ExperienceStorageUnavailable",
				)
				yield* sql.unsafe(
					"DROP TRIGGER reject_app_connection ON openbot_app_connections",
				)
				yield* sql.unsafe("DROP FUNCTION reject_app_connection()")
				assert.deepEqual(
					yield* db
						.select()
						.from(appRecords)
						.where(eq(appRecords.owner, ownerKey(bob))),
					[],
				)
				assert.deepEqual(yield* asOwner(connections.listConnections, bob), [])
				yield* sql.unsafe(
					"CREATE FUNCTION reject_index_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Index work storage unavailable'; END $$",
				)
				yield* sql.unsafe(
					"CREATE TRIGGER reject_index_job BEFORE INSERT ON openbot_app_index_jobs FOR EACH ROW EXECUTE FUNCTION reject_index_job()",
				)
				assert.equal(
					(yield* Effect.flip(
						asOwner(
							connections.createConnection({ ...input, draftId: bobDraft.id }),
							bob,
						),
					))._tag,
					"ExperienceStorageUnavailable",
				)
				yield* sql.unsafe(
					"DROP TRIGGER reject_index_job ON openbot_app_index_jobs",
				)
				yield* sql.unsafe("DROP FUNCTION reject_index_job()")
				assert.deepEqual(
					yield* db
						.select()
						.from(appRecords)
						.where(eq(appRecords.owner, ownerKey(bob))),
					[],
				)
				assert.deepEqual(yield* asOwner(connections.listConnections, bob), [])
				return saved.id
			}),
		)
		await runtime.dispose()
		runtime = makeRuntime()
		await runtime.runPromise(
			Effect.gen(function* () {
				const connections = yield* Connections.Connections
				assert.equal(
					(yield* asOwner(connections.getConnection(id))).enabled,
					true,
				)
				const db = yield* Db.make
				const secrets = yield* Secrets.Secrets
				assert.equal(
					Redacted.value(
						(yield* StoredConnections.get(db, secrets, ownerKey(alice), id))
							.connection.configuration,
					)["header:X-Secret"],
					"private-app-token",
				)
			}),
		)
	} finally {
		await runtime.dispose()
		await publisher.close()
		await database.close()
	}
})

test("connection limits stay atomic across concurrent database pools and storage failures stay failures", async () => {
	const database = await Postgres.start()
	const layer = () =>
		Layer.merge(
			Secrets.layer(encryptionKey),
			Database.layer({ databaseUrl: Redacted.make(database.url) }),
		).pipe(Layer.provide(NodeServices.layer))
	const first = ManagedRuntime.make(layer())
	const second = ManagedRuntime.make(layer())
	try {
		await first.runPromise(Database.migrate)
		const save = (runtime: typeof first, id: string) =>
			runtime.runPromise(
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
						"public",
						ownerKey(alice),
						{ app, connection, name: id },
					).pipe(Effect.result)
				}),
			)
		const results = await Promise.all(
			Array.from({ length: 35 }, (_, index) =>
				save(index % 2 === 0 ? first : second, String(index)),
			),
		)
		assert.equal(
			results.filter((result) => result._tag === "Success").length,
			30,
		)
		assert.equal(
			results.filter((result) => result._tag === "Failure").length,
			5,
		)
	} finally {
		await first.dispose()
		await second.dispose()
		await database.close()
	}
})

test("ordinary HTTP clients prepare and confirm protected Apps without trusting caller authorization claims", async () => {
	const publisher = await Fixture.start()
	const host = await BrowserHost.start({
		publicOrigin: "https://openbot.fixture.test",
		discovery: publisher.discovery,
		appProbe: publisher.probe,
	})
	try {
		const user = await host.login("app-user")
		const headers = {
			cookie:
				AuthApi.SessionCookie +
				"=" +
				encodeURIComponent(Redacted.value(user.session)),
			origin: "https://openbot.fixture.test",
			"content-type": "application/json",
		}
		const prepared = await fetch(host.address + "/v1/connection-drafts", {
			method: "POST",
			headers,
			body: JSON.stringify({ input: publisher.origin + "/card?edition=team" }),
		})
		assert.equal(prepared.status, 201)
		const draft = await prepared.json()
		const response = await fetch(host.address + "/v1/connections", {
			method: "POST",
			headers,
			body: JSON.stringify({
				draftId: draft.id,
				revision: 0,
				cardUrl: publisher.origin + "/card?edition=team",
				remoteIndex: 1,
				name: "Protected account",
				values: {},
				confirmed: true,
				requiresAuthorization: false,
			}),
		})
		assert.equal(response.status, 201)
		const connection = await response.json()
		assert.equal(connection.availability._tag, "PendingAuthorization")
		assert.equal((await fetch(host.address + "/v1/connections")).status, 401)
		const badOrigin = await fetch(host.address + "/v1/connection-drafts", {
			method: "POST",
			headers: { ...headers, origin: "https://foreign.test" },
			body: JSON.stringify({ input: publisher.origin + "/card" }),
		})
		assert.equal(badOrigin.status, 403)
	} finally {
		await host.close()
		await publisher.close()
	}
})
