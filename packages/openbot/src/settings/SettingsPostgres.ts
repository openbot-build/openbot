import { Settings as Api } from "@openbot-build/api"
import { PgClient } from "@effect/sql-pg"
import {
	Cache,
	Clock,
	Duration,
	Effect,
	Layer,
	Option,
	PubSub,
	Queue,
	Schedule,
	Schema,
	Stream,
} from "effect"
import { and, eq, sql } from "drizzle-orm"
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

const platformCodec = Schema.fromJsonString(PlatformDocument)
const organizationCodec = Schema.fromJsonString(OrganizationDocument)
const memberCodec = Schema.fromJsonString(MemberDocument)

const columns = (scope: DocumentScope) =>
	scope.kind === "platform"
		? { scopeKind: "platform", scopeId: "platform" }
		: { scopeKind: scope.kind, scopeId: scope.id }

export const make = Effect.gen(function* () {
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
			.pipe(
				Effect.map((rows) => Option.fromNullishOr(rows[0])),
				Effect.mapError(() => Api.SettingsUnavailable.make({})),
			)

	const decodePlatform = (row: typeof settings.$inferSelect) =>
		Schema.decodeEffect(platformCodec)(row.document).pipe(
			Effect.map((document): Snapshot<PlatformDocument> => ({
				document,
				version: row.version,
				updatedAt: row.updatedAt,
			})),
			Effect.mapError(() => Api.SettingsUnavailable.make({})),
		)
	const decodeOrganization = (row: typeof settings.$inferSelect) =>
		Schema.decodeEffect(organizationCodec)(row.document).pipe(
			Effect.map((document): Snapshot<OrganizationDocument> => ({
				document,
				version: row.version,
				updatedAt: row.updatedAt,
			})),
			Effect.mapError(() => Api.SettingsUnavailable.make({})),
		)

	/**
	 * A missed notice must not keep old settings for ever, so each entry also
	 * expires after a short time.
	 */
	const timeToLive = Duration.seconds(30)
	const platformCache = yield* Cache.make({
		capacity: 1,
		timeToLive,
		lookup: (_: "platform") =>
			read(platformScope).pipe(
				Effect.flatMap(
					Option.match({
						onNone: () => Effect.succeedNone,
						onSome: (row) => Effect.asSome(decodePlatform(row)),
					}),
				),
			),
	})
	const organizationCache = yield* Cache.make({
		capacity: 10_000,
		timeToLive,
		lookup: (organizationId: string) =>
			read(organizationScope(organizationId)).pipe(
				Effect.flatMap(
					Option.match({
						onNone: () =>
							Effect.succeed<Snapshot<OrganizationDocument>>({
								document: organizationDefaults,
								version: 0,
								updatedAt: 0,
							}),
						onSome: decodeOrganization,
					}),
				),
			),
	})
	const memberCache = yield* Cache.make({
		capacity: 10_000,
		timeToLive,
		lookup: (key: string) =>
			read({ kind: "member", id: key }).pipe(
				Effect.flatMap(
					Option.match({
						onNone: () =>
							Effect.succeed<Snapshot<MemberDocument>>({
								document: memberDefaults,
								version: 0,
								updatedAt: 0,
							}),
						onSome: (row) =>
							Schema.decodeEffect(memberCodec)(row.document).pipe(
								Effect.map((document): Snapshot<MemberDocument> => ({
									document,
									version: row.version,
									updatedAt: row.updatedAt,
								})),
								Effect.mapError(() => Api.SettingsUnavailable.make({})),
							),
					}),
				),
			),
	})
	const invalidate = (scope: Scope) =>
		scope.kind === "platform"
			? Cache.invalidate(platformCache, "platform")
			: scope.kind === "organization"
				? Cache.invalidate(organizationCache, scope.id)
				: scope.kind === "member"
					? Cache.invalidate(memberCache, scope.id)
					: Effect.void

	const pubsub = yield* PubSub.unbounded<Scope>()
	yield* Effect.addFinalizer(() => PubSub.shutdown(pubsub))

	/**
	 * Listen for changes from every instance. When the listener connection
	 * breaks, notices can be lost, so forget the whole cache and listen again.
	 */
	const listen = Effect.scoped(
		Effect.gen(function* () {
			const notices = yield* client.listen(channel)
			yield* Cache.invalidateAll(platformCache)
			yield* Cache.invalidateAll(organizationCache)
			yield* Cache.invalidateAll(memberCache)
			while (true) {
				const notice = yield* Queue.take(notices)
				const scope = parseScopeKey(notice.payload)
				if (scope === undefined) continue
				yield* invalidate(scope)
				yield* PubSub.publish(pubsub, scope)
			}
		}),
	)
	yield* listen.pipe(
		Effect.tapError((error) =>
			Effect.logWarning(
				"The settings listener stopped. It starts again.",
				error,
			),
		),
		Effect.retry(Schedule.spaced(Duration.seconds(1))),
		Effect.forkScoped,
	)

	/** Write one document. The notice goes out when the transaction commits. */
	const write = <Document, E, M>(input: {
		readonly scope: DocumentScope
		readonly expectedVersion: number
		readonly codec: Schema.Codec<Document, string>
		readonly initial: Option.Option<Document>
		readonly change: (current: Document) => Effect.Effect<Document, E>
		readonly missing: () => M
	}) =>
		db
			.transaction((tx) =>
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis
					const key = columns(input.scope)
					if (Option.isSome(input.initial)) {
						const encoded = yield* Schema.encodeEffect(input.codec)(
							input.initial.value,
						).pipe(Effect.mapError(() => Api.SettingsUnavailable.make({})))
						yield* tx
							.insert(settings)
							.values({ ...key, document: encoded, version: 0, updatedAt: 0 })
							.onConflictDoNothing()
							.pipe(Effect.mapError(() => Api.SettingsUnavailable.make({})))
					}
					const row = (yield* tx
						.select()
						.from(settings)
						.where(where(input.scope))
						.for("update")
						.pipe(Effect.mapError(() => Api.SettingsUnavailable.make({}))))[0]
					if (row === undefined) return yield* Effect.fail(input.missing())
					if (row.version !== input.expectedVersion)
						return yield* Api.SettingsConflict.make({ version: row.version })
					const current = yield* Schema.decodeEffect(input.codec)(
						row.document,
					).pipe(Effect.mapError(() => Api.SettingsUnavailable.make({})))
					const next = yield* input.change(current)
					const encoded = yield* Schema.encodeEffect(input.codec)(next).pipe(
						Effect.mapError(() => Api.SettingsUnavailable.make({})),
					)
					const version = row.version + 1
					yield* tx
						.update(settings)
						.set({ document: encoded, version, updatedAt: now })
						.where(where(input.scope))
						.pipe(Effect.mapError(() => Api.SettingsUnavailable.make({})))
					yield* tx
						.execute(
							sql`SELECT pg_notify(${channel}, ${scopeKey(input.scope)})`,
						)
						.pipe(Effect.mapError(() => Api.SettingsUnavailable.make({})))
					return { document: next, version, updatedAt: now }
				}),
			)
			.pipe(
				Effect.catchTag("SqlError", () =>
					Effect.fail(Api.SettingsUnavailable.make({})),
				),
				// This instance does not wait for its own notice.
				Effect.tap(() => invalidate(input.scope)),
			)

	return Settings.of({
		platform: Cache.get(platformCache, "platform"),
		organization: (organizationId) =>
			Cache.get(organizationCache, organizationId),
		initializePlatform: (document) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				const encoded = yield* Schema.encodeEffect(platformCodec)(
					document,
				).pipe(Effect.mapError(() => Api.SettingsUnavailable.make({})))
				const inserted = yield* db
					.insert(settings)
					.values({
						...columns(platformScope),
						document: encoded,
						version: 1,
						updatedAt: now,
					})
					.onConflictDoNothing()
					.returning({ version: settings.version })
					.pipe(Effect.mapError(() => Api.SettingsUnavailable.make({})))
				if (inserted.length === 0) return false
				yield* client
					.notify(channel, scopeKey(platformScope))
					.pipe(Effect.mapError(() => Api.SettingsUnavailable.make({})))
				yield* invalidate(platformScope)
				return true
			}),
		replacePlatform: (document) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				const encoded = yield* Schema.encodeEffect(platformCodec)(
					document,
				).pipe(Effect.mapError(() => Api.SettingsUnavailable.make({})))
				const [row] = yield* db
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
					.pipe(Effect.mapError(() => Api.SettingsUnavailable.make({})))
				yield* client
					.notify(channel, scopeKey(platformScope))
					.pipe(Effect.mapError(() => Api.SettingsUnavailable.make({})))
				yield* invalidate(platformScope)
				return { document, version: row?.version ?? 1, updatedAt: now }
			}),
		updatePlatform: (expectedVersion, change) =>
			write({
				scope: platformScope,
				expectedVersion,
				codec: platformCodec,
				initial: Option.none(),
				change,
				missing: () => Api.SetupRequired.make({}),
			}),
		updateOrganization: (organizationId, expectedVersion, change) =>
			write({
				scope: organizationScope(organizationId),
				expectedVersion,
				codec: organizationCodec,
				initial: Option.some(organizationDefaults),
				change,
				missing: () => Api.SettingsUnavailable.make({}),
			}),
		member: (organizationId, userId) =>
			Cache.get(memberCache, memberScope({ organizationId, userId }).id),
		updateMember: (organizationId, userId, expectedVersion, change) =>
			write({
				scope: memberScope({ organizationId, userId }),
				expectedVersion,
				codec: memberCodec,
				initial: Option.some(memberDefaults),
				change,
				missing: () => Api.SettingsUnavailable.make({}),
			}),
		notify: (scope) =>
			client
				.notify(channel, scopeKey(scope))
				.pipe(Effect.mapError(() => Api.SettingsUnavailable.make({}))),
		changes: Stream.fromPubSub(pubsub),
	})
})

export const layer = Layer.effect(Settings, make)
