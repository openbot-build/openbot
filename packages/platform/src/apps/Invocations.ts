import { createHash } from "node:crypto"
import { AppExecution, SessionConflict } from "@openbot-build/platform-api"
import { Context, Effect, Layer, Match, Option } from "effect"
import { ActionPolicy } from "./ActionPolicy.ts"
import { InvocationRepository, type Error } from "./InvocationRepository.ts"
import { Repository } from "./Repository.ts"

export interface Position {
	readonly owner: string
	readonly session: AppExecution.Invocation["session"]
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
>()("@openbot-build/platform/apps/Invocations") {}

export const make: Effect.Effect<
	typeof Invocations.Service,
	never,
	InvocationRepository | Repository | ActionPolicy
> = Effect.gen(function* () {
	const records = yield* InvocationRepository
	const connections = yield* Repository
	const policy = yield* ActionPolicy
	const id = (input: Position, callId: string) =>
		createHash("sha256")
			.update(JSON.stringify([input.owner, input.session, input.turn, callId]))
			.digest("hex")
	const valid = (owner: string, value: AppExecution.Invocation) =>
		Effect.gen(function* () {
			const connection = yield* connections
				.get(owner, value.source.connectionId)
				.pipe(
					Effect.mapError(() =>
						SessionConflict.make({
							message: "The App connection is no longer available.",
						}),
					),
				)
			if (
				connection.revision !== value.source.revision ||
				connection.connection.state !== "Enabled"
			)
				return yield* SessionConflict.make({
					message:
						"The App connection changed. Review the current operation before continuing.",
				})
		})
	const propose = (input: Proposal) =>
		Effect.gen(function* () {
			const readOnly = policy.isRead(input.source)
			// Only tool calls need a decision. Reading resources and prompts does not.
			const covered = input.source.kind !== "tool"
			return yield* records.put(input.owner, {
				id: id(input, input.callId),
				session: input.session,
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
			yield* records.change(
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
					return records
						.change(owner, value.id, ["Sending"], (value) => ({
							...value,
							status,
							result: recorded,
							round: status === "InputRequired" ? value.round + 1 : value.round,
						}))
						.pipe(
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
					records
						.change(owner, value.id, ["Sending"], (current) => ({
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
						}))
						.pipe(
							// After a normal finish the status is no longer "Sending", so this
							// change fails with a conflict. That is expected and safe to skip.
							Effect.catchTag("SessionConflict", () => Effect.void),
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
			records.get(input.owner, id(input, callId)).pipe(
				Effect.asSome,
				Effect.catchTag("ExperienceNotFound", () => Effect.succeedNone),
			),
		approve: (input, callId, approved) =>
			Effect.gen(function* () {
				const value = yield* records.get(input.owner, id(input, callId))
				yield* valid(input.owner, value)
				yield* records.change(
					input.owner,
					value.id,
					["PendingApproval"],
					(value) => ({
						...value,
						status: approved ? "Approved" : "Rejected",
					}),
				)
			}),
		resume: (owner, id, operation) =>
			records
				.get(owner, id)
				.pipe(
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
