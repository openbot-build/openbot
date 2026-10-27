import { Settings as SettingsModel } from "@openbot-build/domain"

import { PgClient } from "@effect/sql-pg"
import {
	Array as Arr,
	Clock,
	Duration,
	Effect,
	Filter,
	Layer,
	Option,
	PubSub,
	Schedule,
	Schema,
	Stream,
} from "effect"
import { and, eq, sql } from "drizzle-orm"
import * as Background from "../execution/Background.ts"
import * as Failures from "../errors/Failures.ts"
import { settings } from "../database/Schema.ts"
import {
	MemberDocument,
	memberDefaults,
	memberScope,
	OrganizationDocument,
	organizationDefaults,
	organizationScope,
	parseScopeKey,
	PlatformDocument,
	platformScope,
	type DocumentScope,
	type Scope,
	scopeKey,
	type Snapshot,
} from "./Documents.ts"
import { Settings } from "./Settings.ts"
import * as Db from "../database/Database.ts"

/** Every instance listens on this channel. The payload is the key of the scope that changed. */
export const channel = "openbot_settings"

/**
 * How many changes can wait for one subscriber of `changes`. When more come,
 * the oldest one goes.
 */
export const changesCapacity = 256

const platformCodec = Schema.fromJsonString(PlatformDocument)
const organizationCodec = Schema.fromJsonString(OrganizationDocument)
const memberCodec = Schema.fromJsonString(MemberDocument)

/** Turns an inside failure into the public error. The log keeps the reason. */
const unavailable = (message: string) =>
	Failures.replace(message, () => SettingsModel.SettingsUnavailable.make({}))

/** Each log of a read or a change names its scope, so the operator can find the row. */
const annotate = (scope: Scope) =>
	Effect.annotateLogs({ settingsScope: scopeKey(scope) })

/** Reads the document of a row. A bad value fails, and the log keeps the reason. */
const decodeSnapshot =
	<D>(codec: Schema.Codec<D, string>, message: string) =>
	(row: typeof settings.$inferSelect) =>
		Schema.decodeEffect(codec)(row.document).pipe(
			Effect.map((document): Snapshot<D> => ({
				document,
				version: row.version,
				updatedAt: row.updatedAt,
			})),
			unavailable(message),
		)

/** The defaults, when nobody changed the settings yet. */
const defaults = <D>(document: D): Snapshot<D> => ({
	document,
	version: 0,
	updatedAt: 0,
})

const columns = (scope: DocumentScope) =>
	scope.kind === "platform"
		? { scopeKind: "platform", scopeId: "platform" }
		: { scopeKind: scope.kind, scopeId: scope.id }

export const make = Effect.gen(function* () {
	const background = yield* Background.make
	const db = yield* Db.make
	const client = yield* PgClient.PgClient
	const where = (scope: DocumentScope) => {
		const { scopeKind, scopeId } = columns(scope)
		return and(eq(settings.scopeKind, scopeKind), eq(settings.scopeId, scopeId))
	}

	const read = (scope: DocumentScope) =>
		db
			.select()
			.from(settings)
			.where(where(scope))
			.pipe(Effect.map(Arr.head), unavailable("Could not read the settings"))

	/** Reads use committed rows. A lost notice must not extend old rights. */
	const platform = read(platformScope).pipe(
		Effect.flatMap(
			Option.match({
				onNone: () => Effect.succeedNone,
				onSome: (row) =>
					decodeSnapshot(
						platformCodec,
						"The stored platform settings have a bad value",
					)(row).pipe(Effect.asSome),
			}),
		),
		annotate(platformScope),
	)
	const organization = (organizationId: string) =>
		read(organizationScope(organizationId)).pipe(
			Effect.flatMap(
				Option.match({
					onNone: () => Effect.succeed(defaults(organizationDefaults)),
					onSome: decodeSnapshot(
						organizationCodec,
						"The stored organization settings have a bad value",
					),
				}),
			),
			annotate(organizationScope(organizationId)),
		)
	const member = (organizationId: string, userId: string) => {
		const scope = memberScope({ organizationId, userId })
		return read(scope).pipe(
			Effect.flatMap(
				Option.match({
					onNone: () => Effect.succeed(defaults(memberDefaults)),
					onSome: decodeSnapshot(
						memberCodec,
						"The stored member settings have a bad value",
					),
				}),
			),
			annotate(scope),
		)
	}

	// A slow subscriber loses its oldest changes, so it cannot make memory grow.
	const pubsub = yield* PubSub.sliding<Scope>(changesCapacity)
	yield* Effect.addFinalizer(() => PubSub.shutdown(pubsub))

	/** Notices wake subscribers. Reads do not depend on delivery of a notice. */
	const notices = Stream.unwrap(
		client.listen(channel).pipe(Effect.map(Stream.fromQueue)),
	)

	yield* background.repeat(
		notices.pipe(
			Stream.filterMap(
				Filter.fromPredicateOption((notice) => parseScopeKey(notice.payload)),
			),
			Stream.runForEach((scope) => PubSub.publish(pubsub, scope)),
		),
		{
			schedule: Schedule.spaced(Duration.seconds(1)),
			message: "The settings listener stopped. It starts again.",
		},
	)

	/** Write one document. The notice goes out when the transaction commits. */
	const write = <Document, E, M>(input: {
		readonly scope: DocumentScope
		readonly expectedVersion: number
		readonly codec: Schema.Codec<Document, string>
		readonly initial: Option.Option<Document>
		readonly change: (current: Document) => Effect.Effect<Document, E>
		/** The row is not there, even after the defaults went in. */
		readonly missing: Effect.Effect<never, M>
	}) =>
		db
			.transaction((tx) =>
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis
					const key = columns(input.scope)
					if (Option.isSome(input.initial)) {
						const encoded = yield* Schema.encodeEffect(input.codec)(
							input.initial.value,
						).pipe(unavailable("Could not encode the default settings"))
						yield* tx
							.insert(settings)
							.values({ ...key, document: encoded, version: 0, updatedAt: 0 })
							.onConflictDoNothing()
							.pipe(unavailable("Could not add the default settings"))
					}
					const found = Arr.head(
						yield* tx
							.select()
							.from(settings)
							.where(where(input.scope))
							.for("update")
							.pipe(unavailable("Could not read the settings to change them")),
					)
					if (Option.isNone(found)) return yield* input.missing
					const row = found.value
					if (row.version !== input.expectedVersion)
						return yield* SettingsModel.SettingsConflict.make({
							version: row.version,
						})
					const current = yield* Schema.decodeEffect(input.codec)(
						row.document,
					).pipe(unavailable("The stored settings have a bad value"))
					const next = yield* input.change(current)
					const encoded = yield* Schema.encodeEffect(input.codec)(next).pipe(
						unavailable("Could not encode the changed settings"),
					)
					const version = row.version + 1
					yield* tx
						.update(settings)
						.set({ document: encoded, version, updatedAt: now })
						.where(where(input.scope))
						.pipe(unavailable("Could not write the changed settings"))
					yield* tx
						.execute(
							sql`SELECT pg_notify(${channel}, ${scopeKey(input.scope)})`,
						)
						.pipe(unavailable("Could not send the settings notice"))
					return { document: next, version, updatedAt: now }
				}),
			)
			.pipe(
				Effect.catchTag("SqlError", (error) =>
					Effect.fail(error).pipe(unavailable("A settings transaction failed")),
				),
				annotate(input.scope),
			)

	return Settings.of({
		platform,
		organization,
		initializePlatform: (document) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				const encoded = yield* Schema.encodeEffect(platformCodec)(
					document,
				).pipe(unavailable("Could not encode the platform settings"))
				// The notice goes out when the transaction commits.
				return yield* db
					.transaction((tx) =>
						Effect.gen(function* () {
							const inserted = yield* tx
								.insert(settings)
								.values({
									...columns(platformScope),
									document: encoded,
									version: 1,
									updatedAt: now,
								})
								.onConflictDoNothing()
								.returning({ version: settings.version })
								.pipe(unavailable("Could not add the platform settings"))
							if (inserted.length === 0) return false
							yield* tx
								.execute(
									sql`SELECT pg_notify(${channel}, ${scopeKey(platformScope)})`,
								)
								.pipe(unavailable("Could not send the settings notice"))
							return true
						}),
					)
					.pipe(
						Effect.catchTag("SqlError", (error) =>
							Effect.fail(error).pipe(
								unavailable("A settings transaction failed"),
							),
						),
					)
			}).pipe(annotate(platformScope)),
		replacePlatform: (document) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				const encoded = yield* Schema.encodeEffect(platformCodec)(
					document,
				).pipe(unavailable("Could not encode the platform settings"))
				// The notice goes out when the transaction commits.
				const version = yield* db
					.transaction((tx) =>
						Effect.gen(function* () {
							const [row] = yield* tx
								.insert(settings)
								.values({
									...columns(platformScope),
									document: encoded,
									version: 1,
									updatedAt: now,
								})
								.onConflictDoUpdate({
									target: [settings.scopeKind, settings.scopeId],
									set: {
										document: encoded,
										version: sql`${settings.version} + 1`,
										updatedAt: now,
									},
								})
								.returning({ version: settings.version })
								.pipe(unavailable("Could not write the platform settings"))
							yield* tx
								.execute(
									sql`SELECT pg_notify(${channel}, ${scopeKey(platformScope)})`,
								)
								.pipe(unavailable("Could not send the settings notice"))
							return row?.version ?? 1
						}),
					)
					.pipe(
						Effect.catchTag("SqlError", (error) =>
							Effect.fail(error).pipe(
								unavailable("A settings transaction failed"),
							),
						),
					)
				return { document, version, updatedAt: now }
			}).pipe(annotate(platformScope)),
		updatePlatform: (expectedVersion, change) =>
			write({
				scope: platformScope,
				expectedVersion,
				codec: platformCodec,
				initial: Option.none(),
				change,
				missing: Effect.fail(SettingsModel.SetupRequired.make({})),
			}),
		updateOrganization: (organizationId, expectedVersion, change) =>
			write({
				scope: organizationScope(organizationId),
				expectedVersion,
				codec: organizationCodec,
				initial: Option.some(organizationDefaults),
				change,
				missing: Effect.die(
					"The settings row is missing after the insert of the defaults.",
				),
			}),
		member,
		updateMember: (organizationId, userId, expectedVersion, change) =>
			write({
				scope: memberScope({ organizationId, userId }),
				expectedVersion,
				codec: memberCodec,
				initial: Option.some(memberDefaults),
				change,
				missing: Effect.die(
					"The settings row is missing after the insert of the defaults.",
				),
			}),
		notify: (scope) =>
			client
				.notify(channel, scopeKey(scope))
				.pipe(
					unavailable("Could not send the settings notice"),
					annotate(scope),
				),
		changes: Stream.fromPubSub(pubsub),
	})
})

export const layer = Layer.effect(Settings, make)
