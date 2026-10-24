import {
	ConnectionsApi as Api,
	ExperienceNotFound,
	ExperienceStorageUnavailable,
} from "@openbot-build/api"
import { Store } from "@openbot-build/protocol"
import { Clock, Effect, Option, Schema } from "effect"
import { and, eq, sql } from "drizzle-orm"
import {
	appConnections,
	appDrafts,
	appIndexJobs,
	appRecords,
} from "../database/Schema.ts"
import type { Secrets } from "../secrets/Secrets.ts"
import * as Db from "../database/Database.ts"

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
}) => JSON.stringify([owner.organizationId, owner.userId])

/** The organization of an owner key. */
const decodeOwner = Schema.decodeUnknownOption(
	Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String])),
)
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
	session.memberships
		.filter((membership) => membership.status === "active")
		.map((membership) =>
			ownerKey({
				organizationId: membership.organizationId,
				userId: session.userId,
			}),
		)

export const unavailable = () => ExperienceStorageUnavailable.make({})
/** Keep the errors that callers handle. Every other storage failure becomes one error. */
export const failure = (error: unknown) =>
	error instanceof ExperienceNotFound || error instanceof Api.ConnectionConflict
		? error
		: unavailable()
const connectionCodec = Schema.fromJsonString(
	Schema.toCodecJson(StoredConnection),
)
export const appCodec = Schema.fromJsonString(Store.AppRecord)
export const draftCodec = Schema.fromJsonString(Api.ConnectionDraft)
const conflict = (reason: Api.ConnectionConflict["reason"], message: string) =>
	Api.ConnectionConflict.make({ reason, message })

type Database = Db.Database
type Sealer = typeof Secrets.Service

const binding = (owner: string, id: string) =>
	JSON.stringify(["connection", owner, id])
/** Open the sealed body of a connection row. */
export const open = (
	secrets: Sealer,
	owner: string,
	id: string,
	body: string,
) =>
	secrets
		.open(body, binding(owner, id))
		.pipe(
			Effect.flatMap(Schema.decodeEffect(connectionCodec)),
			Effect.mapError(unavailable),
		)
const seal = (
	secrets: Sealer,
	owner: string,
	id: string,
	value: StoredConnection,
) =>
	Schema.encodeEffect(connectionCodec)(value).pipe(
		Effect.flatMap((body) => secrets.seal(body, binding(owner, id))),
		Effect.mapError(unavailable),
	)
export const connectionWhere = (owner: string, id: string) =>
	and(eq(appConnections.owner, owner), eq(appConnections.id, id))
const appWhere = (owner: string, cardUrl: string) =>
	and(eq(appRecords.owner, owner), eq(appRecords.cardUrl, cardUrl))
export const draftWhere = (owner: string, id: string) =>
	and(eq(appDrafts.owner, owner), eq(appDrafts.id, id))

export const list = (db: Database, secrets: Sealer, owner: string) =>
	db
		.select()
		.from(appConnections)
		.where(eq(appConnections.owner, owner))
		.orderBy(appConnections.name, appConnections.id)
		.pipe(
			Effect.flatMap((rows) =>
				Effect.forEach(rows, (row) => open(secrets, owner, row.id, row.body)),
			),
			Effect.mapError(unavailable),
		)

export const get = Effect.fn("Apps.getStoredConnection")(function* (
	db: Database,
	secrets: Sealer,
	owner: string,
	id: string,
) {
	const row = (yield* db
		.select()
		.from(appConnections)
		.where(connectionWhere(owner, id))
		.pipe(Effect.mapError(unavailable)))[0]
	if (row === undefined) return yield* ExperienceNotFound.make({ id })
	return yield* open(secrets, owner, id, row.body)
})

export const getApp = Effect.fn("Apps.getApp")(function* (
	db: Database,
	owner: string,
	cardUrl: string,
) {
	const row = (yield* db
		.select()
		.from(appRecords)
		.where(appWhere(owner, cardUrl))
		.pipe(Effect.mapError(unavailable)))[0]
	if (row === undefined) return yield* ExperienceNotFound.make({ id: cardUrl })
	return yield* Schema.decodeEffect(appCodec)(row.body).pipe(
		Effect.mapError(unavailable),
	)
})

export const updateApp = (db: Database, owner: string, app: Store.AppRecord) =>
	Schema.encodeEffect(appCodec)(app).pipe(
		Effect.flatMap((body) =>
			db.update(appRecords).set({ body }).where(appWhere(owner, app.cardUrl)),
		),
		Effect.asVoid,
		Effect.mapError(unavailable),
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
				yield* tx.execute(
					sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["app-connections", owner])}, 0))`,
				)
				const id = input.connection.connectionId
				if (
					input.connection.owner !== owner ||
					input.app.cardUrl !== input.connection.cardUrl
				)
					return yield* unavailable()
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
						return yield* conflict(
							"RevisionChanged",
							"The draft changed. Refresh it before confirming.",
						)
					if (draft.expiresAt <= (yield* Clock.currentTimeMillis))
						return yield* conflict(
							"DraftExpired",
							"This draft expired. Discover the App again.",
						)
				}
				if (
					(yield* tx.$count(appConnections, eq(appConnections.owner, owner))) >=
					30
				)
					return yield* conflict(
						"LimitReached",
						"You can save up to 30 connections. Remove one before adding another.",
					)
				const stored: StoredConnection = {
					connection: input.connection,
					name: input.name.trim(),
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
				if (!input.app.sources.some((source) => source.role === "manual")) {
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
		.pipe(Effect.mapError(failure))

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
					return yield* conflict(
						"RevisionChanged",
						"This connection changed. Refresh it before updating.",
					)
				const updated = yield* Schema.decodeEffect(StoredConnection)({
					...change(previous),
					revision: previous.revision + 1,
				})
				if (
					updated.connection.owner !== owner ||
					updated.connection.connectionId !== id ||
					updated.connection.cardUrl !== previous.connection.cardUrl
				)
					return yield* unavailable()
				const body = yield* seal(secrets, owner, id, updated)
				yield* tx
					.update(appConnections)
					.set({ name: updated.name, revision: updated.revision, body })
					.where(connectionWhere(owner, id))
				return updated
			}),
		)
		.pipe(Effect.mapError(failure))

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
		Effect.mapError(unavailable),
	)
