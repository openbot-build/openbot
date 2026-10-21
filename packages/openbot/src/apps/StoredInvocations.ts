// These are plain query functions that take the database first. A pipeable form does not help here.
// @effect-diagnostics missingPipeableSignature:off
import * as OwnedWrites from "../execution/OwnedWrites.ts"
import {
	AppExecution,
	ExperienceNotFound,
	ExperienceStorageUnavailable,
	SessionConflict,
} from "@openbot-build/api"
import { and, eq, inArray } from "drizzle-orm"
import type { EffectPgDatabase } from "drizzle-orm/effect-postgres"
import { Effect, Schema } from "effect"
import { appInvocations } from "../database/Schema.ts"
import type { Secrets } from "../secrets/Secrets.ts"

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
export const decodeBody = (
	secrets: Sealer,
	row: typeof appInvocations.$inferSelect,
) =>
	secrets
		.open(row.body, binding(row.owner, row.id))
		.pipe(Effect.flatMap(Schema.decodeEffect(codec)))
export const open = (
	secrets: Sealer,
	row: typeof appInvocations.$inferSelect,
) =>
	Effect.gen(function* () {
		const value = yield* decodeBody(secrets, row)
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
	db: EffectPgDatabase,
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
	db: EffectPgDatabase,
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

/** Recover only accounts still assigned to this runtime. Never send an operation again. */
export const recover = (db: EffectPgDatabase) =>
	db
		.selectDistinct({ owner: appInvocations.owner })
		.from(appInvocations)
		.where(eq(appInvocations.status, "Sending"))
		.pipe(
			Effect.flatMap((rows) =>
				Effect.forEach(rows, ({ owner }) =>
					OwnedWrites.recover(
						owner,
						db
							.update(appInvocations)
							.set({ status: "OutcomeUnknown" })
							.where(
								and(
									eq(appInvocations.owner, owner),
									eq(appInvocations.status, "Sending"),
								),
							),
					),
				),
			),
			Effect.asVoid,
			Effect.mapError(unavailable),
		)

/** Change an operation under a row lock when its status is one of `expected`. */
export const change = (
	db: EffectPgDatabase,
	secrets: Sealer,
	owner: string,
	id: string,
	expected: ReadonlyArray<AppExecution.Invocation["status"]>,
	update: (value: AppExecution.Invocation) => AppExecution.Invocation,
	round?: number,
): Effect.Effect<AppExecution.Invocation, Error> =>
	db
		.transaction((tx) =>
			Effect.gen(function* () {
				const row = (yield* tx
					.select()
					.from(appInvocations)
					.where(where(owner, id))
					.for("update"))[0]
				if (row === undefined)
					return yield* ExperienceNotFound.make({ id: "App operation" })
				const current = yield* open(secrets, row)
				if (
					!expected.includes(current.status) ||
					(round !== undefined && current.round !== round)
				)
					return yield* SessionConflict.make({
						message:
							"This App operation changed or was already submitted. Review its recorded result.",
					})
				const value = update(current)
				const body = yield* seal(secrets, owner, value)
				const changed = yield* tx
					.update(appInvocations)
					.set({ status: value.status, body })
					.where(
						and(
							where(owner, id),
							inArray(appInvocations.status, [...expected]),
						),
					)
					.returning({ id: appInvocations.id })
				if (changed.length !== 1)
					return yield* SessionConflict.make({
						message:
							"This App operation changed or was already submitted. Review its recorded result.",
					})
				return value
			}),
		)
		.pipe(
			(effect) => OwnedWrites.write(owner, effect),
			Effect.mapError(failure),
		)
