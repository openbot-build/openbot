import {
	DeltaValidation,
	Item,
	Timeline,
	TimelineSnapshots,
	Session,
	SessionStore,
} from "@openbot-build/core"
import { SessionResponse, SessionSummary } from "@openbot-build/api"
import * as SessionEncoding from "./SessionEncoding.ts"
import { agentFields } from "./SessionHost.ts"
import { Array, Match, Effect, Equal, Schema, Option } from "effect"
import { and, eq, inArray } from "drizzle-orm"
import { refs, versions, contents } from "../database/Schema.ts"
import * as Db from "../database/Database.ts"

/** The Sessions of each namespace, kept in Postgres. */
const { decode, databaseError, conflict, responseSummary } = SessionEncoding
const json = <S extends Schema.ConstraintDecoder<unknown>>(
	schema: S,
	value: string,
) => decode(Schema.fromJsonString(schema))(value)
type Database = Db.Database
const readers = (
	db: Database,
	namespace: string,
	client: Pick<Database, "select">,
) => {
	const refRow = (id: Session.Id) =>
		client
			.select()
			.from(refs)
			.where(and(eq(refs.namespace, namespace), eq(refs.id, id)))
			.pipe(Effect.map(Array.head))
	const storage: SessionStore.Persistence = {
		getRef: (id) =>
			refRow(id).pipe(
				Effect.flatMap(
					Option.match({
						onNone: () => Effect.succeedNone,
						onSome: (row) => json(Session.Ref, row.body).pipe(Effect.asSome),
					}),
				),
				Effect.mapError(databaseError),
			),
		listRefs: (input) =>
			client
				.select({ body: refs.body })
				.from(refs)
				.where(
					and(
						eq(refs.namespace, namespace),
						input?.archived === undefined
							? undefined
							: eq(refs.archived, Number(input.archived)),
					),
				)
				.orderBy(refs.id)
				.pipe(
					Effect.flatMap((rows) =>
						Effect.forEach(rows, (row) => json(Session.Ref, row.body)),
					),
					Effect.mapError(databaseError),
				),
		headers: (ids) =>
			ids.length === 0
				? Effect.succeed([])
				: client
						.select({
							id: versions.id,
							schemaVersion: versions.schemaVersion,
							parents: versions.parents,
						})
						.from(versions)
						.where(
							and(
								eq(versions.namespace, namespace),
								inArray(versions.id, [...ids]),
							),
						)
						.pipe(
							Effect.flatMap((rows) =>
								Effect.forEach(rows, (row) =>
									Effect.gen(function* () {
										return yield* decode(Timeline.Version)({
											...row,
											parents: yield* json(Timeline.Parents, row.parents),
										})
									}),
								),
							),
							Effect.mapError(databaseError),
						),
		snapshot: (id) =>
			Effect.gen(function* () {
				const row = (yield* client
					.select()
					.from(versions)
					.where(
						and(eq(versions.namespace, namespace), eq(versions.id, id)),
					))[0]
				if (row === undefined) return Option.none()
				return Option.some(
					yield* decode(SessionStore.Snapshot)({
						...row,
						snapshotFormatVersion: row.format,
						parents: yield* json(Timeline.Parents, row.parents),
						value: yield* json(Schema.JsonObject, row.value),
						history: yield* json(
							SessionStore.Snapshot.fields.history,
							row.history,
						),
					}),
				)
			}).pipe(Effect.mapError(databaseError)),
		contentHeaders: (ids) =>
			ids.length === 0
				? Effect.succeed([])
				: client
						.select({ id: contents.id, message: contents.message })
						.from(contents)
						.where(
							and(
								eq(contents.namespace, namespace),
								inArray(contents.id, [...ids]),
							),
						)
						.pipe(
							Effect.flatMap((rows) =>
								Effect.forEach(rows, (row) =>
									decode(
										Schema.Struct({
											id: Schema.String,
											message: Item.Record.fields.id,
										}),
									)(row),
								),
							),
							Effect.mapError(databaseError),
						),
		contents: (ids) =>
			ids.length === 0
				? Effect.succeed([])
				: client
						.select({
							id: contents.id,
							message: contents.message,
							content: contents.content,
						})
						.from(contents)
						.where(
							and(
								eq(contents.namespace, namespace),
								inArray(contents.id, [...ids]),
							),
						)
						.pipe(
							Effect.flatMap((rows) =>
								Effect.forEach(rows, (row) =>
									Effect.gen(function* () {
										return yield* decode(SessionStore.Content)({
											...row,
											content: yield* json(Schema.Json, row.content),
										})
									}),
								),
							),
							Effect.mapError(databaseError),
						),
		save: (delta) => save(db, namespace, { delta, response: Option.none() }),
		remove: (ref) => remove(db, namespace, ref),
	}
	return { storage, refRow }
}
/** The core Session store persistence of one namespace. */
export const persistence = (
	db: Database,
	namespace: string,
): SessionStore.Persistence => readers(db, namespace, db).storage
export const save = (
	db: Database,
	namespace: string,
	input: {
		readonly delta: SessionStore.Delta
		/** The response of the current Turn, when the Session has one. */
		readonly response: Option.Option<SessionResponse>
	},
): Effect.Effect<void, SessionStore.SessionStoreError> =>
	db
		.transaction((tx) =>
			Effect.gen(function* () {
				const { storage, refRow } = readers(db, namespace, tx)
				const previous = yield* refRow(input.delta.session.id)
				const delta = yield* DeltaValidation.validateDelta(storage, input.delta)
				for (const message of delta.messages) {
					yield* tx
						.insert(contents)
						.values({
							namespace,
							...message,
							content: JSON.stringify(message.content),
						})
						.onConflictDoNothing()
					const saved = (yield* storage.contents([message.id]))[0]
					if (saved === undefined || !Equal.equals(saved, message))
						return yield* new SessionStore.SessionStoreError({
							reason: "message-conflict",
							message: "Immutable message content conflict",
						})
				}
				for (const version of delta.versions) {
					const inserted = yield* tx
						.insert(versions)
						.values({
							namespace,
							id: version.id,
							schemaVersion: version.schemaVersion,
							parents: JSON.stringify(version.parents),
							format: version.snapshotFormatVersion,
							value: JSON.stringify(version.value),
							history: JSON.stringify(version.history),
						})
						.onConflictDoNothing()
						.returning({ id: versions.id })
					if (inserted.length === 0) {
						const saved = yield* TimelineSnapshots.readRaw(storage, version.id)
						const raw = yield* TimelineSnapshots.unpack(version, [
							...(yield* storage.contents(
								version.history.map((ref) => ref.content),
							)),
							...delta.messages,
						])
						if (
							!Equal.equals(
								{
									id: saved.snapshot.id,
									schemaVersion: saved.snapshot.schemaVersion,
									parents: saved.snapshot.parents,
								},
								{
									id: version.id,
									schemaVersion: version.schemaVersion,
									parents: version.parents,
								},
							) ||
							!TimelineSnapshots.same(saved.raw, raw)
						)
							return yield* new SessionStore.SessionStoreError({
								reason: "version-conflict",
								version: version.id,
								message: "Immutable version conflict",
							})
					}
				}
				const session = delta.session
				const values = {
					body: JSON.stringify(session),
					head: session.head,
					archived: Number(session.metadata.archived),
					status: Session.status(session)._tag,
					turn: Session.currentTurn(session)?.id ?? null,
					response: Option.getOrNull(
						Option.map(input.response, (response) => JSON.stringify(response)),
					),
					responseSummary: Option.getOrNull(
						Option.map(input.response, (response) =>
							JSON.stringify(responseSummary(response)),
						),
					),
					revision: session.revision,
				}
				const written = yield* Option.match(previous, {
					onNone: () =>
						tx
							.insert(refs)
							.values({ namespace, id: session.id, ...values })
							.onConflictDoNothing()
							.returning({ id: refs.id }),
					onSome: (previous) =>
						tx
							.update(refs)
							.set(values)
							.where(
								and(
									eq(refs.namespace, namespace),
									eq(refs.id, session.id),
									eq(refs.revision, previous.revision),
								),
							)
							.returning({ id: refs.id }),
				})
				if (written.length !== 1) return yield* conflict()
			}),
		)
		.pipe(Effect.mapError(databaseError))
export const remove = (
	db: Database,
	namespace: string,
	ref: Session.Ref,
): Effect.Effect<void, SessionStore.SessionStoreError> =>
	db
		.transaction((tx) =>
			Effect.gen(function* () {
				const found = yield* readers(db, namespace, tx).refRow(ref.id)
				if (Option.isNone(found)) return yield* conflict()
				const row = found.value
				if (!Equal.equals(yield* json(Session.Ref, row.body), ref))
					return yield* conflict()
				const result = yield* tx
					.delete(refs)
					.where(
						and(
							eq(refs.namespace, namespace),
							eq(refs.id, ref.id),
							eq(refs.revision, row.revision),
						),
					)
					.returning({ id: refs.id })
				if (result.length !== 1) return yield* conflict()
			}),
		)
		.pipe(Effect.mapError(databaseError))
export const list = (
	db: Database,
	namespace: string,
	input?: Parameters<SessionStore.Persistence["listRefs"]>[0],
): Effect.Effect<
	ReadonlyArray<SessionSummary>,
	SessionStore.SessionStoreError
> =>
	db
		.select({
			body: refs.body,
			status: refs.status,
			turn: refs.turn,
			response: refs.responseSummary,
		})
		.from(refs)
		.where(
			and(
				eq(refs.namespace, namespace),
				input?.archived === undefined
					? undefined
					: eq(refs.archived, Number(input.archived)),
			),
		)
		.orderBy(refs.id)
		.pipe(
			Effect.flatMap((rows) =>
				Effect.forEach(rows, (row) =>
					Effect.gen(function* () {
						const session = yield* json(Session.Ref, row.body)
						return yield* decode(SessionSummary)({
							session,
							...agentFields(session),
							status: row.status,
							turn: row.turn,
							response:
								row.response === null
									? null
									: yield* json(SessionSummary.fields.response, row.response),
							activity: Match.value(row).pipe(
								Match.when({ status: "Running" }, () => "historical" as const),
								Match.orElse(() => "inactive" as const),
							),
						})
					}),
				),
			),
			Effect.mapError(databaseError),
		)
