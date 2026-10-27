import type { Settings as SettingsApi } from "@openbot-build/api"
import type { Caller, Execution } from "@openbot-build/domain"
import { Effect, Layer, Option, type Redacted } from "effect"
import { eq } from "drizzle-orm"
import { Publication } from "../../src/app/DevelopmentApps.ts"
import * as TestStoresLayer from "../../src/apps/DeveloperTestStores.ts"
import { DeveloperTestStores } from "../../src/apps/DeveloperTestStores.ts"
// These services must use the same build as the development server.
import { DeveloperTests } from "../../dist/apps/DeveloperTests.js"
import { DeveloperWatches } from "../../dist/apps/DeveloperWatches.js"
import { DeveloperIndexing } from "../../dist/apps/DeveloperIndexing.js"
import { IndexWork } from "../../dist/apps/IndexWork.js"
import { Settings } from "../../dist/settings/Settings.js"
import { IndexNamespace } from "../../src/apps/IndexNamespace.ts"
import * as Rows from "../../src/apps/DeveloperRows.ts"
import { ownerKey } from "../../src/apps/StoredConnections.ts"
import * as Database from "../../src/database/DatabasePostgres.ts"
import * as Db from "../../src/database/Database.ts"
import { executionFailures } from "../../src/database/ExecutionSchema.ts"
import {
	developerNotices,
	developerProofs,
	developerSubscriptions,
} from "../../src/database/Schema.ts"
import * as Secrets from "../../src/secrets/Secrets.ts"
import * as Wait from "../Wait.ts"

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
		Layer.provide(Layer.succeed(IndexNamespace, "development")),
		Layer.provide(Secrets.layer(options.secretKeys)),
		Layer.provide(Database.layer(options)),
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
			Layer.merge(Database.layer(options), Secrets.layer(options.secretKeys)),
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

/** Writes deployment rules while the test server is stopped. */
export const writeRestrictions = (
	appRestrictions: SettingsApi.PlatformSettings["appRestrictions"],
) =>
	Effect.gen(function* () {
		const settings = yield* Settings
		const current = yield* Effect.fromOption(yield* settings.platform)
		return yield* settings.updatePlatform(current.version, (document) =>
			Effect.succeed({ ...document, appRestrictions }),
		)
	})

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
	Effect.flatMap(Db.make, (db) => Rows.getApp(db, "development", cardUrl))

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
