import { getApp } from "@openbot-build/apps-contract/apps/DeveloperRows"
import type { PlatformSettings } from "@openbot-build/domain/Settings"
import type { Caller } from "@openbot-build/domain/Identity"
import { IndexStore } from "@openbot-build/protocol"
import { PgClient } from "@effect/sql-pg"
import type { Execution } from "@openbot-build/domain"
import { Effect, Layer, Option, type Redacted } from "effect"
import { eq } from "drizzle-orm"
import { Publication } from "@openbot-build/server-development/DevelopmentApps"
import * as TestStoresLayer from "@openbot-build/plugin-apps/DeveloperTestStores"
import { DeveloperTestStores } from "@openbot-build/plugin-apps/DeveloperTestStores"
// These services must use the same build as the development server. The package entry gives that build.
import { DeveloperTests } from "@openbot-build/plugin-apps/DeveloperTests"
import { DeveloperWatches } from "@openbot-build/plugin-apps/DeveloperWatches"
import { DeveloperIndexing } from "@openbot-build/plugin-apps/DeveloperIndexing"
import { Settings } from "@openbot-build/server-kernel/Settings"
import { InstanceSettings } from "@openbot-build/server-kernel/InstanceSettings"
import { IndexWork } from "@openbot-build/apps-contract/apps/IndexWork"
import * as Rows from "@openbot-build/plugin-apps/DeveloperRows"
import { ownerKey } from "@openbot-build/apps-contract/apps/StoredConnections"
import * as Db from "@openbot-build/server-database/Database"
import { executionFailures } from "@openbot-build/server-database/ExecutionSchema"
import {
	developerNotices,
	developerProofs,
	developerSubscriptions,
} from "@openbot-build/server-database/Schema"
import * as ErrorRecords from "@openbot-build/server-kernel/Records"
import * as Secrets from "@openbot-build/server-kernel/Secrets"
import * as SettingsPostgres from "@openbot-build/server-kernel/SettingsPostgres"
import * as Wait from "./Wait.ts"

/**
 * The services of plugins that the helpers of this module read. A test gives
 * them to `TestHost.startWith`.
 */
export const services = [
	DeveloperTests,
	DeveloperWatches,
	DeveloperIndexing,
	IndexStore.IndexStore,
	IndexWork,
] as const

/** Sets the public state of the App used by the development server. */
export const setPublication = (
	mode: Parameters<typeof Publication.Service.set>[0],
) => Effect.flatMap(Publication, (publication) => publication.set(mode))

/** Gives the storage key of a test account. */
export const ownerForMember = (member: {
	readonly organizationId: string
	readonly userId: string
}) => ownerKey(member)

/** Sends an OAuth result with a chosen account to test the owner check. */
export const receiveForOwners = (
	callback: string,
	owners: ReadonlyArray<string>,
) =>
	Effect.flatMap(DeveloperTests, (tests) =>
		tests.receive(callback, Option.some(owners)),
	)

interface StoreOptions {
	readonly databaseUrl: Redacted.Redacted<string>
	readonly secretKeys: Redacted.Redacted<string>
}

/** Opens new database connections, as a second server would after a restart. */
const freshStores = (options: StoreOptions) =>
	TestStoresLayer.layer.pipe(
		Layer.provide(
			Layer.succeed(InstanceSettings, {
				databaseUrl: options.databaseUrl,
				development: true,
				pluginsFile: Option.none(),
			}),
		),
		Layer.provide(Secrets.layer(options.secretKeys)),
		Layer.provide(PgClient.layer({ url: options.databaseUrl })),
	)

/** Read a sealed failure from a new connection to check the public error ID. */
export const readFailure = (
	options: StoreOptions,
	errorId: Execution.ErrorId,
) =>
	Effect.gen(function* () {
		const db = yield* Db.make
		const secrets = yield* Secrets.Secrets
		const [row] = yield* db
			.select()
			.from(executionFailures)
			.where(eq(executionFailures.id, errorId))
		if (row === undefined)
			return yield* Effect.die("The failure record is missing.")
		return {
			sealed: row.cause,
			details: yield* secrets.open(row.cause, `failure:${errorId}`),
		}
	}).pipe(
		Effect.provide(
			Layer.merge(
				PgClient.layer({ url: options.databaseUrl }),
				Secrets.layer(options.secretKeys),
			),
		),
	)

/** Reads a saved OAuth flow from a new database connection. */
export const readStoredFlow = (
	options: StoreOptions,
	owner: string,
	id: string,
	flowId: string,
) =>
	Effect.flatMap(DeveloperTestStores, (stores) =>
		stores.bind(owner, id).flows.get({
			key: { owner, connectionId: id },
			flowId,
		}),
	).pipe(Effect.provide(freshStores(options)))

/** Reads the saved authorization and its sealed tokens from a new connection. */
export const readStoredAuthorization = (
	options: StoreOptions,
	owner: string,
	id: string,
) =>
	Effect.gen(function* () {
		const stores = (yield* DeveloperTestStores).bind(owner, id)
		const connection = yield* stores.apps.get({ owner, connectionId: id })
		const credential =
			connection.authorization._tag === "Authorized"
				? yield* stores.credentials.get({
						binding: connection.authorization.binding,
						reference: connection.authorization.credentialRef,
					})
				: null
		return { authorization: connection.authorization, credential }
	}).pipe(Effect.provide(freshStores(options)))

/** Asks the shared App monitor for a check and waits for its saved result. */
export const checkApp = (cardUrl: string) =>
	Effect.gen(function* () {
		const watches = yield* DeveloperWatches
		const requested = yield* watches.request({ kind: "App", id: cardUrl })
		yield* Wait.untilTrue(
			"the App monitor check",
			watches.load(requested.key),
			(current) => current.row.revision > requested.revision,
		)
	})

/** Gets the saved monitor job so a test can set a database fault for that job. */
export const ensureAppWatch = (cardUrl: string) =>
	Effect.flatMap(DeveloperWatches, (watches) =>
		watches.ensure({ kind: "App", id: cardUrl }, 0),
	)

/** Asks for a saved monitor check that may continue after the server restarts. */
export const requestAppWatch = (cardUrl: string) =>
	Effect.flatMap(DeveloperWatches, (watches) =>
		watches.request({ kind: "App", id: cardUrl }),
	)

/**
 * Writes deployment rules into the database of a stopped test server. It
 * opens its own database pool, which closes after the write.
 */
export const writeRestrictions = (
	database: {
		readonly databaseUrl: Redacted.Redacted<string>
		readonly secretKeys: Redacted.Redacted<string>
	},
	appRestrictions: PlatformSettings["appRestrictions"],
) =>
	Effect.gen(function* () {
		const settings = yield* Settings
		const current = yield* Effect.fromOption(yield* settings.platform)
		return yield* settings.updatePlatform(current.version, (document) =>
			Effect.succeed({ ...document, appRestrictions }),
		)
	}).pipe(
		Effect.provide(
			SettingsPostgres.layer.pipe(
				Layer.provideMerge(ErrorRecords.layer),
				Layer.provideMerge(Secrets.layer(database.secretKeys)),
				Layer.provideMerge(PgClient.layer({ url: database.databaseUrl })),
			),
		),
	)

/** Starts a fresh public Index check after a change to deployment rules. */
export const requestIndexCheck = (cardUrl: string) =>
	Effect.flatMap(IndexWork, (work) => work.request(cardUrl, []))

/** Reads the saved result of one public Index check. */
export const readIndexCheck = (cardUrl: string, generation: string) =>
	Effect.flatMap(IndexWork, (work) => work.job(cardUrl, generation))

/** Reads a saved developer request after a server restart. */
export const readIndexRequest = (owner: string, id: string) =>
	Effect.flatMap(DeveloperIndexing, (indexing) => indexing.get(owner, id))

/** Requests indexing with a chosen account to test deployment rules. */
export const requestIndex = (
	actor: Caller,
	cardUrl: string,
	key: Execution.CommandKey,
) =>
	Effect.flatMap(DeveloperIndexing, (indexing) =>
		indexing.request(actor, cardUrl, key),
	)

/** Reads the next monitor time saved for an App. */
export const readSavedApp = (cardUrl: string) =>
	Effect.flatMap(Db.make, (db) => getApp(db, "development", cardUrl))

/** Reads the test state saved before the server was stopped. */
export const readSavedTest = (id: string) =>
	Effect.flatMap(Db.make, (db) => Rows.getTest(db, "development", id))

/** Reads saved proofs in the development namespace. */
export const readProofs = Effect.flatMap(Db.make, (db) =>
	db
		.select()
		.from(developerProofs)
		.where(eq(developerProofs.namespace, "development")),
)

/** Reads saved notices, including read times that the public response omits. */
export const readNotices = Effect.flatMap(Db.make, (db) =>
	db.select().from(developerNotices),
)

/** Reads saved notification choices after a server restart. */
export const readSubscriptions = Effect.flatMap(Db.make, (db) =>
	db.select().from(developerSubscriptions),
)
