import { Caller, OrganizationApi } from "@openbot-build/platform-api"
import type { PgClient } from "@effect/sql-pg"
import { Clock, DateTime, Effect, Layer, Schema } from "effect"
import { and, desc, eq, lt } from "drizzle-orm"
import { makeWithDefaults } from "drizzle-orm/effect-postgres"
import { auditLogs } from "../database/Schema.ts"
import { AuditLog, AuditUnavailable } from "./AuditLog.ts"

const decodeActor = Schema.decodeUnknownSync(Schema.fromJsonString(Caller))
const decodeDetails = Schema.decodeUnknownSync(
	Schema.fromJsonString(Schema.JsonObject),
)
const decodeAction = Schema.decodeUnknownSync(OrganizationApi.AuditAction)

export const make: Effect.Effect<
	typeof AuditLog.Service,
	never,
	PgClient.PgClient
> = Effect.gen(function* () {
	const db = yield* makeWithDefaults()
	const unavailable = () => AuditUnavailable.make({})
	return AuditLog.of({
		record: (entry) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				yield* db.insert(auditLogs).values({
					organizationId: entry.organizationId,
					createdAt: now,
					action: entry.action,
					actorUserId: entry.actor.userId,
					actor: JSON.stringify(entry.actor),
					resource: entry.resource,
					details: JSON.stringify(entry.details),
				})
			}).pipe(Effect.mapError(unavailable)),
		list: (organizationId, options) =>
			Effect.gen(function* () {
				const after =
					options.after === undefined ? Number.NaN : Number(options.after)
				const rows = yield* db
					.select()
					.from(auditLogs)
					.where(
						and(
							eq(auditLogs.organizationId, organizationId),
							Number.isSafeInteger(after)
								? lt(auditLogs.sequence, after)
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
					items: page.map((row) => ({
						id: String(row.sequence),
						createdAt: DateTime.formatIso(DateTime.makeUnsafe(row.createdAt)),
						action: decodeAction(row.action),
						actor: decodeActor(row.actor),
						resource: row.resource,
						details: decodeDetails(row.details),
					})),
					next:
						rows.length > options.limit
							? String(page[page.length - 1]?.sequence)
							: null,
				}
			}).pipe(Effect.mapError(unavailable)),
	})
})
export const layer = Layer.effect(AuditLog, make)
