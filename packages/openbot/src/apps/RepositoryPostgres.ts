import {
	ConnectionsApi as Api,
	ExperienceNotFound,
	ExperienceStorageUnavailable,
} from "@openbot-build/api"
import { Store } from "@openbot-build/protocol"
import type { PgClient } from "@effect/sql-pg"
import { Clock, Effect, Layer, Schema } from "effect"
import { and, eq, inArray, sql } from "drizzle-orm"
import { makeWithDefaults } from "drizzle-orm/effect-postgres"
import {
	appConnections,
	appDrafts,
	appRecords,
	appIndexJobs,
	appSecrets,
} from "../database/Schema.ts"
import { Repository, StoredConnection } from "./Repository.ts"
import { Secrets } from "../secrets/Secrets.ts"

const unavailable = () => ExperienceStorageUnavailable.make({})
/** Keep the errors that callers handle. Every other storage failure becomes one error. */
const failure = (error: unknown) =>
	error instanceof ExperienceNotFound || error instanceof Api.ConnectionConflict
		? error
		: unavailable()
const connectionCodec = Schema.fromJsonString(
	Schema.toCodecJson(StoredConnection),
)
const appCodec = Schema.fromJsonString(Store.AppRecord)
const draftCodec = Schema.fromJsonString(Api.ConnectionDraft)
const conflict = (reason: Api.ConnectionConflict["reason"], message: string) =>
	Api.ConnectionConflict.make({ reason, message })

export const makeFor = (
	namespace: string,
): Effect.Effect<
	typeof Repository.Service,
	never,
	PgClient.PgClient | Secrets
> =>
	Effect.gen(function* () {
		const db = yield* makeWithDefaults()
		const secrets = yield* Secrets
		const binding = (owner: string, id: string) =>
			JSON.stringify(["connection", owner, id])
		const decode = (owner: string, id: string, body: string) =>
			secrets
				.open(body, binding(owner, id))
				.pipe(
					Effect.flatMap(Schema.decodeEffect(connectionCodec)),
					Effect.mapError(unavailable),
				)
		const encode = (owner: string, id: string, value: StoredConnection) =>
			Schema.encodeEffect(connectionCodec)(value).pipe(
				Effect.flatMap((body) => secrets.seal(body, binding(owner, id))),
				Effect.mapError(unavailable),
			)
		const connectionWhere = (owner: string, id: string) =>
			and(eq(appConnections.owner, owner), eq(appConnections.id, id))
		const appWhere = (owner: string, cardUrl: string) =>
			and(eq(appRecords.owner, owner), eq(appRecords.cardUrl, cardUrl))
		const draftWhere = (owner: string, id: string) =>
			and(eq(appDrafts.owner, owner), eq(appDrafts.id, id))
		const getDraft = Effect.fn("Apps.getDraft")(function* (
			owner: string,
			id: string,
		) {
			const row = (yield* db
				.select()
				.from(appDrafts)
				.where(draftWhere(owner, id))
				.pipe(Effect.mapError(unavailable)))[0]
			if (row === undefined) return yield* ExperienceNotFound.make({ id })
			return yield* Schema.decodeEffect(draftCodec)(row.body).pipe(
				Effect.mapError(unavailable),
			)
		})
		return Repository.of({
			list: (owner) =>
				db
					.select()
					.from(appConnections)
					.where(eq(appConnections.owner, owner))
					.orderBy(appConnections.name, appConnections.id)
					.pipe(
						Effect.flatMap((rows) =>
							Effect.forEach(rows, (row) => decode(owner, row.id, row.body)),
						),
						Effect.mapError(unavailable),
					),
			get: Effect.fn("Apps.getConnection")(function* (owner, id) {
				const row = (yield* db
					.select()
					.from(appConnections)
					.where(connectionWhere(owner, id))
					.pipe(Effect.mapError(unavailable)))[0]
				if (row === undefined) return yield* ExperienceNotFound.make({ id })
				return yield* decode(owner, id, row.body)
			}),
			listApps: (owner) =>
				db
					.select()
					.from(appRecords)
					.where(eq(appRecords.owner, owner))
					.pipe(
						Effect.flatMap((rows) =>
							Effect.forEach(rows, (row) =>
								Schema.decodeEffect(appCodec)(row.body),
							),
						),
						Effect.mapError(unavailable),
					),
			getApp: Effect.fn("Apps.getApp")(function* (owner, cardUrl) {
				const row = (yield* db
					.select()
					.from(appRecords)
					.where(appWhere(owner, cardUrl))
					.pipe(Effect.mapError(unavailable)))[0]
				if (row === undefined)
					return yield* ExperienceNotFound.make({ id: cardUrl })
				return yield* Schema.decodeEffect(appCodec)(row.body).pipe(
					Effect.mapError(unavailable),
				)
			}),
			updateApp: (owner, app) =>
				Schema.encodeEffect(appCodec)(app).pipe(
					Effect.flatMap((body) =>
						db
							.update(appRecords)
							.set({ body })
							.where(appWhere(owner, app.cardUrl)),
					),
					Effect.asVoid,
					Effect.mapError(unavailable),
				),
			save: (owner, input) =>
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
								return yield* decode(owner, id, existing.body)
							if (input.draftRevision !== undefined) {
								const row = (yield* tx
									.select()
									.from(appDrafts)
									.where(draftWhere(owner, id)))[0]
								if (row === undefined)
									return yield* ExperienceNotFound.make({ id })
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
								(yield* tx.$count(
									appConnections,
									eq(appConnections.owner, owner),
								)) >= 30
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
							const body = yield* encode(owner, id, stored)
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
								!input.app.sources.some((source) => source.role === "manual")
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
					.pipe(Effect.mapError(failure)),
			update: (owner, id, change, revision) =>
				db
					.transaction((tx) =>
						Effect.gen(function* () {
							const row = (yield* tx
								.select()
								.from(appConnections)
								.where(connectionWhere(owner, id))
								.for("update"))[0]
							if (row === undefined)
								return yield* ExperienceNotFound.make({ id })
							const previous = yield* decode(owner, id, row.body)
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
							const body = yield* encode(owner, id, updated)
							yield* tx
								.update(appConnections)
								.set({ name: updated.name, revision: updated.revision, body })
								.where(connectionWhere(owner, id))
							return updated
						}),
					)
					.pipe(Effect.mapError(failure)),
			remove: (owner, id) =>
				db
					.transaction((tx) =>
						Effect.gen(function* () {
							const rows = yield* tx
								.delete(appConnections)
								.where(connectionWhere(owner, id))
								.returning({ id: appConnections.id })
							if (rows.length === 0)
								return yield* ExperienceNotFound.make({ id })
							yield* tx
								.delete(appSecrets)
								.where(
									and(
										eq(appSecrets.owner, owner),
										eq(appSecrets.connectionId, id),
									),
								)
						}),
					)
					.pipe(Effect.mapError(failure)),
			saveDraft: (owner, draft) =>
				Schema.encodeEffect(draftCodec)(draft).pipe(
					Effect.flatMap((body) =>
						db.insert(appDrafts).values({ owner, id: draft.id, body }),
					),
					Effect.as(draft),
					Effect.mapError(unavailable),
				),
			getDraft,
			clearDrafts: (owner) =>
				db
					.transaction((tx) =>
						Effect.gen(function* () {
							yield* tx.delete(appDrafts).where(eq(appDrafts.owner, owner))
							yield* tx
								.delete(appSecrets)
								.where(
									and(
										eq(appSecrets.owner, owner),
										inArray(appSecrets.kind, [
											"app-view",
											"app-ui-state",
											"app-view-action",
										]),
									),
								)
						}),
					)
					.pipe(Effect.mapError(unavailable)),
		})
	})
export const make = makeFor("public")
export const layerFor = (namespace: string) =>
	Layer.effect(Repository, makeFor(namespace))
export const layer = layerFor("public")
