import { NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { AppIndexApi as Api } from "@openbot-build/api"
import type { Execution } from "@openbot-build/domain"
import { Client, Index, Store } from "@openbot-build/protocol"
import { Effect, Layer, Redacted } from "effect"
import { AppHost } from "../../src/apps/AppHost.ts"
import * as PublicIndex from "../../src/apps/Index.ts"
import * as IndexStore from "../../src/apps/IndexStore.ts"
import { IndexWork } from "../../src/apps/IndexWork.ts"
import * as Governance from "../../src/apps/Governance.ts"
import * as StoredConnections from "../../src/apps/StoredConnections.ts"
import * as Db from "../../src/database/Database.ts"
import * as Database from "../../src/database/DatabasePostgres.ts"
import * as Migration from "../../src/database/Migrations.ts"
import { appIndexEntries } from "../../src/database/Schema.ts"
import * as ExecutionStore from "../../src/execution/Store.ts"
import * as Secrets from "../../src/secrets/Secrets.ts"
import type * as BrowserHost from "../BrowserHost.ts"
import * as OrganizationFixture from "../OrganizationFixture.ts"

/** Ask the public Index worker to check one App now. */
export const requestCheck = (host: BrowserHost.Host, cardUrl: string) =>
	host.run(Effect.flatMap(IndexWork, (work) => work.request(cardUrl, [])))

/** Read one saved Index job while the worker runs. */
export const checkJob = (
	host: BrowserHost.Host,
	cardUrl: string,
	generation: string,
) =>
	host.run(Effect.flatMap(IndexWork, (work) => work.job(cardUrl, generation)))

/** Read an entry after a public check. */
export const readPublicEntry = (host: BrowserHost.Host, cardUrl: string) =>
	host.run(
		Effect.flatMap(PublicIndex.PublicIndex, (index) => index.get(cardUrl)),
	)

/** Read the public list after a worker has changed it. */
export const searchPublicEntries = (host: BrowserHost.Host, query: Api.Query) =>
	host.run(
		Effect.flatMap(PublicIndex.PublicIndex, (index) => index.search(query)),
	)

/** Read storage to check that a withdrawn App was removed. */
export const readStoredEntry = (host: BrowserHost.Host, cardUrl: string) =>
	host.run(Effect.flatMap(Index.IndexStore, (index) => index.get(cardUrl)))

/** Read the calls of one check to test its retry rules. */
export const executionCalls = (
	host: BrowserHost.Host,
	key: { readonly namespace: string; readonly id: Execution.Id },
) => host.run(Effect.flatMap(ExecutionStore.Store, (store) => store.calls(key)))

/** Read sealed failure details to check that a saved check kept its full cause. */
export const failureRecords = (
	host: BrowserHost.Host,
	executionId: Execution.Id,
) =>
	host.run(
		Effect.gen(function* () {
			const sql = yield* PgClient.PgClient
			const secrets = yield* Secrets.Secrets
			const rows = yield* sql<{
				readonly id: string
				readonly cause: string
			}>`select id, cause from openbot_execution_failures where execution_id = ${executionId}`
			return yield* Effect.forEach(rows, (row) =>
				Effect.map(secrets.open(row.cause, `failure:${row.id}`), (details) => ({
					sealed: row.cause,
					details,
				})),
			)
		}),
	)

/** Use the same owner key as a stored App connection. */
export const connectionOwner = (owner: {
	readonly organizationId: string
	readonly userId: string
}) => StoredConnections.ownerKey(owner)

/** Opens a saved connection to observe the public restriction failure. */
export const restrictedConnectionFailure = (
	host: BrowserHost.Host,
	owner: string,
	connectionId: string,
) =>
	host.run(
		Effect.scoped(
			Effect.gen(function* () {
				const app = (yield* AppHost).bind(
					owner,
					Client.InvocationPolicy.of({ check: () => Effect.void }),
				)
				return yield* Effect.flip(
					app.open({
						key: { owner, connectionId },
						clientInfo: { name: "Policy fixture", version: "1.0.0" },
					}),
				)
			}),
		),
	)

/** Seed a connection that was saved before a public restriction. */
export const saveExistingConnection = (
	host: BrowserHost.Host,
	input: {
		readonly owner: string
		readonly name: string
		readonly app: Store.AppRecord
		readonly connectionId: string
		readonly endpoint: string
	},
) =>
	host.run(
		Effect.gen(function* () {
			return yield* StoredConnections.save(
				yield* Db.make,
				yield* Secrets.Secrets,
				yield* IndexWork,
				input.owner,
				{
					name: input.name,
					app: input.app,
					connection: Store.UserConnection.make({
						owner: input.owner,
						connectionId: input.connectionId,
						cardUrl: input.app.cardUrl,
						endpoint: input.endpoint,
						remoteIndex: 0,
						configuration: Redacted.make({}),
						headers: Redacted.make({}),
						state: "Enabled",
						authorization: { _tag: "Unprotected" },
					}),
				},
			)
		}),
	)

/** Build the saved Index with a second source and one source that is offline. */
export const storedFixture = (databaseUrl: string, second: Index.Entry) =>
	Effect.gen(function* () {
		const db = Database.layer({ databaseUrl: Redacted.make(databaseUrl) }).pipe(
			Layer.provide(NodeServices.layer),
		)
		const repository = IndexStore.layer.pipe(Layer.provideMerge(db))
		const context = yield* Layer.build(
			PublicIndex.layer({
				providers: [
					{
						source: {
							id: "second",
							name: "Second Index",
							url: "https://second.test/v1/app-index/apps",
							simulated: false,
						},
						entries: Effect.succeed([second]),
					},
					{
						source: {
							id: "offline",
							name: "Offline Index",
							url: "https://offline.test/v1/app-index/apps",
							simulated: false,
						},
						entries: Effect.fail(
							Api.IndexUnavailable.make({
								issues: [{ source: "offline", message: "Offline" }],
							}),
						),
					},
				],
			}).pipe(
				Layer.provideMerge(repository),
				Layer.provide(Governance.layer),
				Layer.provide(
					OrganizationFixture.layerSettings({
						publicOrigin: "https://openbot.test",
					}),
				),
			),
		)
		yield* Migration.initialize.pipe(Effect.provide(context))
		return {
			search: (query: Api.Query) =>
				Effect.flatMap(PublicIndex.PublicIndex, (index) =>
					index.search(query),
				).pipe(Effect.provide(context)),
			get: (cardUrl: string) =>
				Effect.flatMap(PublicIndex.PublicIndex, (index) =>
					index.get(cardUrl),
				).pipe(Effect.provide(context)),
			upsert: (entry: Index.Entry) =>
				Effect.flatMap(Index.IndexStore, (store) => store.upsert(entry)).pipe(
					Effect.provide(context),
				),
			savedCountFromNewPool: Effect.flatMap(Db.make, (database) =>
				database.select().from(appIndexEntries),
			).pipe(
				Effect.map((rows) => rows.length),
				Effect.provide(repository),
			),
		}
	})
