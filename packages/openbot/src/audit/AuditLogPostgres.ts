import { Caller, OrganizationApi } from "@openbot-build/api"
import type { PgClient } from "@effect/sql-pg"
import { Clock, DateTime, Effect, Layer, Option, Schema } from "effect"
import { and, desc, eq, lt } from "drizzle-orm"
import { auditLogs } from "../database/Schema.ts"
import { AuditLog, AuditUnavailable } from "./AuditLog.ts"
import * as Db from "../database/Database.ts"

const ActorJson = Schema.fromJsonString(Caller)
const DetailsJson = Schema.fromJsonString(Schema.JsonObject)
const decodeActor = Schema.decodeUnknownEffect(ActorJson)
const decodeDetails = Schema.decodeUnknownEffect(DetailsJson)
/** Only this file writes these columns, from typed values, so a failed encode is a defect. */
const encodeActor = (actor: Caller) =>
	Schema.encodeEffect(ActorJson)(actor).pipe(Effect.orDie)
const encodeDetails = (details: Schema.JsonObject) =>
	Schema.encodeEffect(DetailsJson)(details).pipe(Effect.orDie)
/** The cursor of a page is the sequence of its last entry. Another cursor starts at the first page. */
const decodeSequence = Schema.decodeUnknownOption(
	Schema.FiniteFromString.pipe(Schema.decodeTo(Schema.Int)),
)
const decodeAction = Schema.decodeUnknownEffect(OrganizationApi.AuditAction)

export const make: Effect.Effect<
	typeof AuditLog.Service,
	never,
	PgClient.PgClient
> = Effect.gen(function* () {
	const db = yield* Db.make
	return AuditLog.of({
		record: (entry) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				yield* db.insert(auditLogs).values({
					organizationId: entry.organizationId,
					createdAt: now,
					action: entry.action,
					actorUserId: entry.actor.userId,
					actor: yield* encodeActor(entry.actor),
					resource: entry.resource,
					details: yield* encodeDetails(entry.details),
				})
			}).pipe(Effect.mapError((cause) => AuditUnavailable.make({ cause }))),
		list: (organizationId, options) =>
			Effect.gen(function* () {
				const after =
					options.after === undefined
						? Option.none()
						: decodeSequence(options.after)
				const rows = yield* db
					.select()
					.from(auditLogs)
					.where(
						and(
							eq(auditLogs.organizationId, organizationId),
							Option.isSome(after)
								? lt(auditLogs.sequence, after.value)
								: undefined,
							options.action === undefined
								? undefined
								: eq(auditLogs.action, options.action),
							options.actor === undefined
								? undefined
								: eq(auditLogs.actorUserId, options.actor),
						),
					)
					.orderBy(desc(auditLogs.sequence))
					.limit(options.limit + 1)
				const page = rows.slice(0, options.limit)
				return {
					items: yield* Effect.forEach(page, (row) =>
						Effect.gen(function* () {
							return {
								id: String(row.sequence),
								createdAt: DateTime.formatIso(
									DateTime.makeUnsafe(row.createdAt),
								),
								action: yield* decodeAction(row.action),
								actor: yield* decodeActor(row.actor),
								resource: row.resource,
								details: yield* decodeDetails(row.details),
							}
						}),
					),
					next:
						rows.length > options.limit
							? String(page[page.length - 1]?.sequence)
							: null,
				}
			}).pipe(Effect.mapError((cause) => AuditUnavailable.make({ cause }))),
	})
})
export const layer = Layer.effect(AuditLog, make)
