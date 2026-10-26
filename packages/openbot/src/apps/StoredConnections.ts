import {
	ConnectionsApi as Api,
	ExperienceNotFound,
	ExperienceStorageUnavailable,
} from "@openbot-build/api"
import { Store } from "@openbot-build/protocol"
import {
	Array as Arr,
	Clock,
	Effect,
	Option,
	pipe,
	Schema,
	String as Str,
} from "effect"
import { and, eq, sql } from "drizzle-orm"
import {
	appConnections,
	appDrafts,
	appIndexJobs,
	appRecords,
} from "../database/Schema.ts"
import type { Secrets } from "../secrets/Secrets.ts"
import * as Db from "../database/Database.ts"
import * as Failures from "../app/Failures.ts"

/** An owner key is the JSON of `[organization id, user id]`. */
const OwnerJson = Schema.fromJsonString(
	Schema.Tuple([Schema.String, Schema.String]),
)
// @effect-diagnostics-next-line schemaSync:off -- Two strings always encode to JSON, so this can not throw, and many callers need the key as a plain string.
const encodeOwner = Schema.encodeSync(OwnerJson)
const LockJson = Schema.fromJsonString(
	Schema.Tuple([Schema.Literal("app-connections"), Schema.String]),
)

/** The App connections of each owner, with their App records and drafts, kept in Postgres. */
export type Error =
	ExperienceNotFound | ExperienceStorageUnavailable | Api.ConnectionConflict
export const StoredConnection = Schema.Struct({
	connection: Store.UserConnection,
	name: Api.ConnectionName,
	revision: Schema.Natural,
	verification: Schema.NullOr(Api.Availability),
})
export type StoredConnection = typeof StoredConnection.Type
export interface SaveRequest {
	readonly app: Store.AppRecord
	readonly connection: Store.UserConnection
	readonly name: string
	readonly draftRevision?: number
}
export const ownerKey = (owner: {
	readonly organizationId: string
	readonly userId: string
}) => encodeOwner([owner.organizationId, owner.userId])

/** The organization of an owner key. */
const decodeOwner = Schema.decodeUnknownOption(OwnerJson)
export const organizationOf = (owner: string): string =>
	Option.match(decodeOwner(owner), {
		onNone: () => "",
		onSome: ([organizationId]) => organizationId,
	})

/** The owner keys of a signed-in account: one for each active membership. */
export const ownersOf = (session: {
	readonly userId: string
	readonly memberships: ReadonlyArray<{
		readonly organizationId: string
		readonly status: string
	}>
}) =>
	pipe(
		session.memberships,
		Arr.filter((membership) => membership.status === "active"),
		Arr.map((membership) =>
			ownerKey({
				organizationId: membership.organizationId,
				userId: session.userId,
			}),
		),
	)

/**
 * Log a storage failure that the caller can not act on, and replace it with
 * one error. The error goes to the client, so it does not hold the failure.
 */
const unavailable = (message: string) =>
	Failures.replace(message, () => ExperienceStorageUnavailable.make({}))
const connectionCodec = Schema.fromJsonString(
	Schema.toCodecJson(StoredConnection),
)
export const appCodec = Schema.fromJsonString(Store.AppRecord)
export const draftCodec = Schema.fromJsonString(Api.ConnectionDraft)

type Database = Db.Database
type Sealer = typeof Secrets.Service

/** Open the sealed body of a connection row. */
export const open = (
	secrets: Sealer,
	owner: string,
	id: string,
	body: string,
) =>
	secrets
		.open(body, JSON.stringify(["connection", owner, id]))
		.pipe(
			Effect.flatMap(Schema.decodeEffect(connectionCodec)),
			unavailable("Could not open a stored App connection."),
		)
const seal = (
	secrets: Sealer,
	owner: string,
	id: string,
	value: StoredConnection,
) =>
	Schema.encodeEffect(connectionCodec)(value).pipe(
		Effect.flatMap((body) =>
			secrets.seal(body, JSON.stringify(["connection", owner, id])),
		),
		unavailable("Could not seal an App connection."),
	)
export const connectionWhere = (owner: string, id: string) =>
	and(eq(appConnections.owner, owner), eq(appConnections.id, id))
export const draftWhere = (owner: string, id: string) =>
	and(eq(appDrafts.owner, owner), eq(appDrafts.id, id))

export const list = (db: Database, secrets: Sealer, owner: string) =>
	db
		.select()
		.from(appConnections)
		.where(eq(appConnections.owner, owner))
		.orderBy(appConnections.name, appConnections.id)
		.pipe(
			unavailable("Could not list App connections."),
			Effect.flatMap((rows) =>
				Effect.forEach(rows, (row) => open(secrets, owner, row.id, row.body)),
			),
		)

export const find = Effect.fn("Apps.findStoredConnection")(function* (
	db: Database,
	secrets: Sealer,
	owner: string,
	id: string,
) {
	const rows = yield* db
		.select()
		.from(appConnections)
		.where(connectionWhere(owner, id))
		.pipe(unavailable("Could not read an App connection."))
	return yield* Effect.transposeOption(
		Option.map(Arr.head(rows), (row) => open(secrets, owner, id, row.body)),
	)
})

export const get = Effect.fn("Apps.getStoredConnection")(function* (
	db: Database,
	secrets: Sealer,
	owner: string,
	id: string,
) {
	return yield* Effect.fromOption(yield* find(db, secrets, owner, id), () =>
		ExperienceNotFound.make({ id }),
	)
})

export const getApp = Effect.fn("Apps.getApp")(function* (
	db: Database,
	owner: string,
	cardUrl: string,
) {
	const row = (yield* db
		.select()
		.from(appRecords)
		.where(and(eq(appRecords.owner, owner), eq(appRecords.cardUrl, cardUrl)))
		.pipe(unavailable("Could not read an App record.")))[0]
	if (row === undefined) return yield* ExperienceNotFound.make({ id: cardUrl })
	return yield* Schema.decodeEffect(appCodec)(row.body).pipe(
		unavailable("Could not decode a stored App record."),
	)
})

export const updateApp = (db: Database, owner: string, app: Store.AppRecord) =>
	Schema.encodeEffect(appCodec)(app).pipe(
		Effect.flatMap((body) =>
			db
				.update(appRecords)
				.set({ body })
				.where(
					and(eq(appRecords.owner, owner), eq(appRecords.cardUrl, app.cardUrl)),
				),
		),
		Effect.asVoid,
		unavailable("Could not update an App record."),
	)

/**
 * Save a new connection and its App record.
 * An App that is not added by hand also gets an index job in the namespace.
 * When the connection exists already, return it unchanged.
 */
export const save = (
	db: Database,
	secrets: Sealer,
	namespace: string,
	owner: string,
	input: SaveRequest,
): Effect.Effect<StoredConnection, Error> =>
	db
		.transaction((tx) =>
			Effect.gen(function* () {
				const lock = yield* Schema.encodeEffect(LockJson)([
					"app-connections",
					owner,
				]).pipe(Effect.orDie)
				yield* tx.execute(
					sql`SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0))`,
				)
				const id = input.connection.connectionId
				if (
					input.connection.owner !== owner ||
					input.app.cardUrl !== input.connection.cardUrl
				)
					return yield* Effect.die(
						"An App connection save named another owner or another App card.",
					)
				const existing = (yield* tx
					.select()
					.from(appConnections)
					.where(connectionWhere(owner, id)))[0]
				if (existing !== undefined)
					return yield* open(secrets, owner, id, existing.body)
				if (input.draftRevision !== undefined) {
					const row = (yield* tx
						.select()
						.from(appDrafts)
						.where(draftWhere(owner, id)))[0]
					if (row === undefined) return yield* ExperienceNotFound.make({ id })
					const draft = yield* Schema.decodeEffect(draftCodec)(row.body)
					if (draft.revision !== input.draftRevision)
						return yield* Api.ConnectionConflict.make({
							reason: "RevisionChanged",
							message: "The draft changed. Refresh it before confirming.",
						})
					if (draft.expiresAt <= (yield* Clock.currentTimeMillis))
						return yield* Api.ConnectionConflict.make({
							reason: "DraftExpired",
							message: "This draft expired. Discover the App again.",
						})
				}
				if (
					(yield* tx.$count(appConnections, eq(appConnections.owner, owner))) >=
					30
				)
					return yield* Api.ConnectionConflict.make({
						reason: "LimitReached",
						message:
							"You can save up to 30 connections. Remove one before adding another.",
					})
				const stored: StoredConnection = {
					connection: input.connection,
					name: Str.trim(input.name),
					revision: 0,
					verification: null,
				}
				const body = yield* seal(secrets, owner, id, stored)
				const appBody = yield* Schema.encodeEffect(appCodec)(input.app)
				yield* tx
					.insert(appRecords)
					.values({ owner, cardUrl: input.app.cardUrl, body: appBody })
					.onConflictDoUpdate({
						target: [appRecords.owner, appRecords.cardUrl],
						set: { body: appBody },
					})
				yield* tx
					.insert(appConnections)
					.values({ owner, id, name: stored.name, revision: 0, body })
				if (
					!Arr.some(input.app.sources, (source) => source.role === "manual")
				) {
					yield* tx
						.insert(appIndexJobs)
						.values({
							namespace,
							cardUrl: input.connection.cardUrl,
							nextCheckAt: 0,
						})
						.onConflictDoNothing()
				}
				return stored
			}),
		)
		.pipe(
			Effect.catchTag(
				["EffectDrizzleQueryError", "SqlError", "SchemaError"],
				(error) =>
					Effect.fail(error).pipe(
						unavailable("Could not save an App connection."),
					),
			),
		)

/**
 * Change a connection under a row lock and raise its revision.
 * When `revision` is given, the change fails if the connection has another revision.
 */
export const update = (
	db: Database,
	secrets: Sealer,
	owner: string,
	id: string,
	change: (stored: StoredConnection) => StoredConnection,
	revision?: number,
): Effect.Effect<StoredConnection, Error> =>
	db
		.transaction((tx) =>
			Effect.gen(function* () {
				const row = (yield* tx
					.select()
					.from(appConnections)
					.where(connectionWhere(owner, id))
					.for("update"))[0]
				if (row === undefined) return yield* ExperienceNotFound.make({ id })
				const previous = yield* open(secrets, owner, id, row.body)
				if (revision !== undefined && previous.revision !== revision)
					return yield* Api.ConnectionConflict.make({
						reason: "RevisionChanged",
						message: "This connection changed. Refresh it before updating.",
					})
				const updated = yield* Schema.decodeEffect(StoredConnection)({
					...change(previous),
					revision: previous.revision + 1,
				})
				if (
					updated.connection.owner !== owner ||
					updated.connection.connectionId !== id ||
					updated.connection.cardUrl !== previous.connection.cardUrl
				)
					return yield* Effect.die(
						"An App connection change moved the connection to another owner, id or App card.",
					)
				const body = yield* seal(secrets, owner, id, updated)
				yield* tx
					.update(appConnections)
					.set({ name: updated.name, revision: updated.revision, body })
					.where(connectionWhere(owner, id))
				return updated
			}),
		)
		.pipe(
			Effect.catchTag(
				["EffectDrizzleQueryError", "SqlError", "SchemaError"],
				(error) =>
					Effect.fail(error).pipe(
						unavailable("Could not update an App connection."),
					),
			),
		)

export const saveDraft = (
	db: Database,
	owner: string,
	draft: Api.ConnectionDraft,
) =>
	Schema.encodeEffect(draftCodec)(draft).pipe(
		Effect.flatMap((body) =>
			db.insert(appDrafts).values({ owner, id: draft.id, body }),
		),
		Effect.as(draft),
		unavailable("Could not save an App connection draft."),
	)
