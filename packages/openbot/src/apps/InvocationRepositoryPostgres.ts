import type { PgClient } from "@effect/sql-pg"
import {
	AppExecution,
	ExperienceNotFound,
	ExperienceStorageUnavailable,
	SessionConflict,
} from "@openbot-build/api"
import { and, eq, inArray } from "drizzle-orm"
import { makeWithDefaults } from "drizzle-orm/effect-postgres"
import { Effect, Layer, Schema } from "effect"
import { appInvocations } from "../database/Schema.ts"
import { InvocationRepository } from "./InvocationRepository.ts"
import { Secrets } from "../secrets/Secrets.ts"

const unavailable = () => ExperienceStorageUnavailable.make({})
const conflict = () =>
	SessionConflict.make({
		message:
			"This App operation changed or was already submitted. Review its recorded result.",
	})
/** Keep the errors that callers handle. Every other storage failure becomes one error. */
const mapError = (error: unknown) =>
	error instanceof SessionConflict || error instanceof ExperienceNotFound
		? error
		: unavailable()
const codec = Schema.fromJsonString(AppExecution.Invocation)
export const make: Effect.Effect<
	typeof InvocationRepository.Service,
	never,
	PgClient.PgClient | Secrets
> = Effect.gen(function* () {
	const db = yield* makeWithDefaults()
	const secrets = yield* Secrets
	const binding = (owner: string, id: string) =>
		JSON.stringify(["app-invocation", owner, id])
	const where = (owner: string, id: string) =>
		and(eq(appInvocations.owner, owner), eq(appInvocations.id, id))
	const encode = (owner: string, value: AppExecution.Invocation) =>
		Schema.encodeEffect(codec)(value).pipe(
			Effect.flatMap((body) => secrets.seal(body, binding(owner, value.id))),
		)
	const decode = (row: typeof appInvocations.$inferSelect) =>
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
	const get = (owner: string, id: string) =>
		Effect.gen(function* () {
			const row = (yield* db
				.select()
				.from(appInvocations)
				.where(where(owner, id)))[0]
			if (row === undefined)
				return yield* ExperienceNotFound.make({ id: "App operation" })
			return yield* decode(row)
		}).pipe(Effect.mapError(mapError))
	return InvocationRepository.of({
		recover: db
			.update(appInvocations)
			.set({ status: "OutcomeUnknown" })
			.where(eq(appInvocations.status, "Sending"))
			.pipe(Effect.asVoid, Effect.mapError(unavailable)),
		get,
		list: (owner, session) =>
			db
				.select()
				.from(appInvocations)
				.where(
					and(
						eq(appInvocations.owner, owner),
						eq(appInvocations.session, session),
					),
				)
				.pipe(
					Effect.flatMap((rows) => Effect.forEach(rows, decode)),
					Effect.mapError(unavailable),
				),
		put: (owner, value) =>
			Effect.gen(function* () {
				const body = yield* encode(owner, value)
				yield* db
					.insert(appInvocations)
					.values({
						owner,
						id: value.id,
						session: value.session,
						status: value.status,
						body,
					})
					.onConflictDoNothing()
				const saved = yield* get(owner, value.id)
				if (
					saved.session !== value.session ||
					saved.turn !== value.turn ||
					saved.callId !== value.callId ||
					saved.toolName !== value.toolName ||
					!Schema.toEquivalence(AppExecution.Source)(
						saved.source,
						value.source,
					) ||
					!Schema.toEquivalence(Schema.JsonObject)(
						saved.arguments,
						value.arguments,
					)
				)
					return yield* conflict()
				return saved
			}).pipe(Effect.mapError(mapError)),
		change: (owner, id, expected, change, round) =>
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
						const current = yield* decode(row)
						if (
							!expected.includes(current.status) ||
							(round !== undefined && current.round !== round)
						)
							return yield* conflict()
						const value = change(current)
						const body = yield* encode(owner, value)
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
						if (changed.length !== 1) return yield* conflict()
						return value
					}),
				)
				.pipe(Effect.mapError(mapError)),
	})
})
export const layer = Layer.effect(InvocationRepository, make)
