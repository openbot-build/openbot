import {
	AppExecution,
	ExperienceNotFound,
	ExperienceStorageUnavailable,
	SessionConflict,
} from "@openbot-build/api"
import { and, eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { appInvocations } from "../database/Schema.ts"
import type { Secrets } from "../secrets/Secrets.ts"
import * as Db from "../database/Database.ts"

/** The App operations of each owner, kept sealed in Postgres. */
export type Error =
	ExperienceNotFound | ExperienceStorageUnavailable | SessionConflict
export const unavailable = () => ExperienceStorageUnavailable.make({})
/** Keep the errors that callers handle. Every other storage failure becomes one error. */
export const failure = (error: unknown) =>
	error instanceof SessionConflict || error instanceof ExperienceNotFound
		? error
		: unavailable()
const codec = Schema.fromJsonString(AppExecution.Invocation)
type Sealer = typeof Secrets.Service

const binding = (owner: string, id: string) =>
	JSON.stringify(["app-invocation", owner, id])
export const where = (owner: string, id: string) =>
	and(eq(appInvocations.owner, owner), eq(appInvocations.id, id))
export const seal = (
	secrets: Sealer,
	owner: string,
	value: AppExecution.Invocation,
) =>
	Schema.encodeEffect(codec)(value).pipe(
		Effect.flatMap((body) => secrets.seal(body, binding(owner, value.id))),
	)
export const open = (
	secrets: Sealer,
	row: typeof appInvocations.$inferSelect,
) =>
	Effect.gen(function* () {
		const value = yield* secrets
			.open(row.body, binding(row.owner, row.id))
			.pipe(Effect.flatMap(Schema.decodeEffect(codec)))
		return yield* Schema.decodeUnknownEffect(AppExecution.Invocation)({
			...value,
			status: row.status,
			result:
				row.status === "OutcomeUnknown"
					? {
							_tag: "Failed",
							operationId: value.id,
							source: value.source,
							reason: "OutcomeUnknown",
							message:
								"This operation may have reached the App. Check its actual state before taking another action.",
						}
					: value.result,
		})
	})

export const get = (
	db: Db.Database,
	secrets: Sealer,
	owner: string,
	id: string,
): Effect.Effect<AppExecution.Invocation, Error> =>
	Effect.gen(function* () {
		const row = (yield* db
			.select()
			.from(appInvocations)
			.where(where(owner, id)))[0]
		if (row === undefined)
			return yield* ExperienceNotFound.make({ id: "App operation" })
		return yield* open(secrets, row)
	}).pipe(Effect.mapError(failure))

export const list = (
	db: Db.Database,
	secrets: Sealer,
	owner: string,
	session: string,
) =>
	db
		.select()
		.from(appInvocations)
		.where(
			and(eq(appInvocations.owner, owner), eq(appInvocations.session, session)),
		)
		.pipe(
			Effect.flatMap((rows) =>
				Effect.forEach(rows, (row) => open(secrets, row)),
			),
			Effect.mapError(unavailable),
		)
