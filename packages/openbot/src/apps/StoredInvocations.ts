import { outcomeUnknownMessage } from "./AppResults.ts"
import {
	ExperienceNotFound,
	ExperienceStorageUnavailable,
	ChatConflict,
} from "@openbot-build/domain"
import { AppCalls } from "@openbot-build/domain"

import { and, eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { appInvocations } from "../database/Schema.ts"
import type { Secrets } from "../secrets/Secrets.ts"
import * as Db from "../database/Database.ts"
import * as Failures from "../errors/Failures.ts"

/** The App operations of each owner, kept sealed in Postgres. */
export type Error =
	ExperienceNotFound | ExperienceStorageUnavailable | ChatConflict
/**
 * Log a storage failure that the caller can not act on, and replace it with
 * one error. The error goes to the client, so it does not hold the failure.
 */
export const unavailable = (message: string) =>
	Failures.replace(message, () => ExperienceStorageUnavailable.make({}))
const codec = Schema.fromJsonString(AppCalls.Invocation)
const AadJson = Schema.fromJsonString(
	Schema.Tuple([
		Schema.Literal("app-invocation"),
		Schema.String,
		Schema.String,
	]),
)
/** The sealed body of an operation opens only with its own owner and ID. */
const aad = (owner: string, id: string) =>
	Schema.encodeEffect(AadJson)(["app-invocation", owner, id]).pipe(Effect.orDie)
type Sealer = typeof Secrets.Service

export const where = (owner: string, id: string) =>
	and(eq(appInvocations.owner, owner), eq(appInvocations.id, id))
export const seal = (
	secrets: Sealer,
	owner: string,
	value: AppCalls.Invocation,
) =>
	Effect.all([Schema.encodeEffect(codec)(value), aad(owner, value.id)]).pipe(
		Effect.flatMap(([body, data]) => secrets.seal(body, data)),
	)
export const open = (
	secrets: Sealer,
	row: typeof appInvocations.$inferSelect,
) =>
	Effect.gen(function* () {
		const value = yield* aad(row.owner, row.id).pipe(
			Effect.flatMap((data) => secrets.open(row.body, data)),
			Effect.flatMap(Schema.decodeEffect(codec)),
		)
		return yield* Schema.decodeUnknownEffect(AppCalls.Invocation)({
			...value,
			status: row.status,
			result:
				row.status === "OutcomeUnknown"
					? {
							_tag: "Failed",
							operationId: value.id,
							source: value.source,
							reason: "OutcomeUnknown",
							message: outcomeUnknownMessage,
						}
					: value.result,
		})
	})

export const get = (
	db: Db.Database,
	secrets: Sealer,
	owner: string,
	id: string,
): Effect.Effect<AppCalls.Invocation, Error> =>
	Effect.gen(function* () {
		const row = (yield* db
			.select()
			.from(appInvocations)
			.where(where(owner, id))
			.pipe(unavailable("Could not read an App operation.")))[0]
		if (row === undefined)
			return yield* ExperienceNotFound.make({ id: "App operation" })
		return yield* open(secrets, row).pipe(
			unavailable("Could not open a stored App operation."),
		)
	})

export const list = (
	db: Db.Database,
	secrets: Sealer,
	owner: string,
	chat: string,
) =>
	db
		.select()
		.from(appInvocations)
		.where(and(eq(appInvocations.owner, owner), eq(appInvocations.chat, chat)))
		.pipe(
			Effect.flatMap((rows) =>
				Effect.forEach(rows, (row) => open(secrets, row)),
			),
			unavailable("Could not list App operations."),
		)
