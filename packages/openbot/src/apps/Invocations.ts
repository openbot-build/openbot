import { createHash } from "node:crypto"
import {
	AppExecution,
	ExperienceNotFound,
	ExperienceStorageUnavailable,
	ChatConflict,
} from "@openbot-build/api"
import { Context, Effect, Layer, Match, Option, Schema } from "effect"
import type { PgClient } from "@effect/sql-pg"
import { and, eq, inArray } from "drizzle-orm"
import { appInvocations } from "../database/Schema.ts"
import { Secrets } from "../secrets/Secrets.ts"
import { ActionPolicy } from "./ActionPolicy.ts"
import * as StoredConnections from "./StoredConnections.ts"
import { organizationOf } from "./StoredConnections.ts"
import * as StoredInvocations from "./StoredInvocations.ts"
import type { Error } from "./StoredInvocations.ts"
import * as Db from "../database/Database.ts"

export interface Position {
	readonly owner: string
	readonly chat: AppExecution.Invocation["chat"]
	readonly turn: AppExecution.Invocation["turn"]
}
export interface Proposal extends Position {
	readonly callId: string
	readonly toolName: string
	readonly source: AppExecution.Source
	readonly arguments: AppExecution.Invocation["arguments"]
}
export class Invocations extends Context.Service<
	Invocations,
	{
		readonly propose: (
			input: Proposal,
		) => Effect.Effect<AppExecution.Invocation, Error>
		readonly pending: (
			input: Position,
			callId: string,
		) => Effect.Effect<Option.Option<AppExecution.Invocation>, Error>
		/** Records the decision about a proposed call. Capability checks make the decision. */
		readonly approve: (
			input: Position,
			callId: string,
			approved: boolean,
		) => Effect.Effect<void, Error>
		readonly resume: (
			owner: string,
			id: string,
			operation: Effect.Effect<AppExecution.Result>,
		) => Effect.Effect<AppExecution.Result, Error>
		readonly execute: (
			input: Proposal,
			operation: Effect.Effect<AppExecution.Result>,
		) => Effect.Effect<AppExecution.Result, Error>
	}
>()("@openbot-build/openbot/apps/Invocations") {}

export const make: Effect.Effect<
	typeof Invocations.Service,
	ExperienceStorageUnavailable,
	PgClient.PgClient | Secrets | ActionPolicy
> = Effect.gen(function* () {
	const db = yield* Db.make
	const secrets = yield* Secrets
	const policy = yield* ActionPolicy
	// An operation that was sending when the host stopped may or may not have reached the App.
	yield* db
		.update(appInvocations)
		.set({ status: "OutcomeUnknown" })
		.where(eq(appInvocations.status, "Sending"))
		.pipe(Effect.mapError(StoredInvocations.unavailable))
	const conflict = () =>
		ChatConflict.make({
			message:
				"This App operation changed or was already submitted. Review its recorded result.",
		})
	const get = (owner: string, id: string) =>
		StoredInvocations.get(db, secrets, owner, id)
	const put = (owner: string, value: AppExecution.Invocation) =>
		Effect.gen(function* () {
			const body = yield* StoredInvocations.seal(secrets, owner, value)
			yield* db
				.insert(appInvocations)
				.values({
					owner,
					id: value.id,
					chat: value.chat,
					status: value.status,
					body,
				})
				.onConflictDoNothing()
			const saved = yield* get(owner, value.id)
			if (
				saved.chat !== value.chat ||
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
		}).pipe(Effect.mapError(StoredInvocations.failure))
	/** Change an operation under a row lock when its status is one of `expected`. */
	const change = (
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
						.where(StoredInvocations.where(owner, id))
						.for("update"))[0]
					if (row === undefined)
						return yield* ExperienceNotFound.make({ id: "App operation" })
					const current = yield* StoredInvocations.open(secrets, row)
					if (
						!expected.includes(current.status) ||
						(round !== undefined && current.round !== round)
					)
						return yield* conflict()
					const value = update(current)
					const body = yield* StoredInvocations.seal(secrets, owner, value)
					const changed = yield* tx
						.update(appInvocations)
						.set({ status: value.status, body })
						.where(
							and(
								StoredInvocations.where(owner, id),
								inArray(appInvocations.status, [...expected]),
							),
						)
						.returning({ id: appInvocations.id })
					if (changed.length !== 1) return yield* conflict()
					return value
				}),
			)
			.pipe(Effect.mapError(StoredInvocations.failure))
	const id = (input: Position, callId: string) =>
		createHash("sha256")
			.update(JSON.stringify([input.owner, input.chat, input.turn, callId]))
			.digest("hex")
	const valid = (owner: string, value: AppExecution.Invocation) =>
		Effect.gen(function* () {
			const connection = yield* StoredConnections.get(
				db,
				secrets,
				owner,
				value.source.connectionId,
			).pipe(
				Effect.mapError(() =>
					ChatConflict.make({
						message: "The App connection is no longer available.",
					}),
				),
			)
			if (
				connection.revision !== value.source.revision ||
				connection.connection.state !== "Enabled"
			)
				return yield* ChatConflict.make({
					message:
						"The App connection changed. Review the current operation before continuing.",
				})
		})
	const propose = (input: Proposal) =>
		Effect.gen(function* () {
			const readOnly = yield* policy.isRead({
				organizationId: organizationOf(input.owner),
				source: input.source,
			})
			// Only tool calls need a decision. Reading resources and prompts does not.
			const covered = input.source.kind !== "tool"
			return yield* put(input.owner, {
				id: id(input, input.callId),
				chat: input.chat,
				turn: input.turn,
				callId: input.callId,
				toolName: input.toolName,
				source: input.source,
				arguments: input.arguments,
				readOnly,
				round: 0,
				status: covered ? "Approved" : "PendingApproval",
				result: null,
			})
		})
	const submit = (
		owner: string,
		value: AppExecution.Invocation,
		expected: ReadonlyArray<AppExecution.Invocation["status"]>,
		operation: Effect.Effect<AppExecution.Result>,
	) =>
		Effect.gen(function* () {
			yield* valid(owner, value)
			yield* change(
				owner,
				value.id,
				expected,
				(current) => ({ ...current, status: "Sending" }),
				value.round,
			)
			return yield* operation.pipe(
				Effect.flatMap((result) => {
					const recorded = { ...result, operationId: value.id }
					const status = Match.value(result).pipe(
						Match.tag("Completed", () => "Completed" as const),
						Match.tag("InputRequired", () => "InputRequired" as const),
						Match.tag("Failed", (result) =>
							result.reason === "OutcomeUnknown"
								? ("OutcomeUnknown" as const)
								: ("Failed" as const),
						),
						Match.exhaustive,
					)
					return change(owner, value.id, ["Sending"], (value) => ({
						...value,
						status,
						result: recorded,
						round: status === "InputRequired" ? value.round + 1 : value.round,
					})).pipe(
						Effect.as(recorded),
						Effect.orElseSucceed(
							() =>
								({
									_tag: "Failed",
									operationId: value.id,
									source: value.source,
									reason: "OutcomeUnknown",
									message:
										"The App returned a response, but it could not be saved. Check the recorded operation before taking another action.",
									result: Match.value(recorded).pipe(
										Match.tag("Completed", ({ result }) => result),
										Match.orElse(() => null),
									),
								}) as const,
						),
					)
				}),
				Effect.ensuring(
					change(owner, value.id, ["Sending"], (current) => ({
						...current,
						status: value.readOnly ? "Failed" : "OutcomeUnknown",
						result: value.readOnly
							? {
									_tag: "Failed",
									source: value.source,
									operationId: value.id,
									reason: "Interrupted",
									message: "This read did not finish.",
								}
							: null,
					})).pipe(
						// After a normal finish the status is no longer "Sending", so this
						// change fails with a conflict. That is expected and safe to skip.
						Effect.catchTag("ChatConflict", () => Effect.void),
						Effect.catch((error) =>
							Effect.logWarning("App operation status could not be closed", {
								source: "apps",
								operation: value.id,
								error: error._tag,
							}),
						),
					),
				),
			)
		})
	return Invocations.of({
		propose,
		pending: (input, callId) =>
			get(input.owner, id(input, callId)).pipe(
				Effect.asSome,
				Effect.catchTag("ExperienceNotFound", () => Effect.succeedNone),
			),
		approve: (input, callId, approved) =>
			Effect.gen(function* () {
				const value = yield* get(input.owner, id(input, callId))
				yield* valid(input.owner, value)
				yield* change(input.owner, value.id, ["PendingApproval"], (value) => ({
					...value,
					status: approved ? "Approved" : "Rejected",
				}))
			}),
		resume: (owner, id, operation) =>
			get(owner, id).pipe(
				Effect.flatMap((value) =>
					submit(owner, value, ["InputRequired"], operation),
				),
			),
		execute: (input, operation) =>
			propose(input).pipe(
				Effect.flatMap((value) =>
					submit(input.owner, value, ["Approved"], operation),
				),
			),
	})
})
export const layer = Layer.effect(Invocations, make)
