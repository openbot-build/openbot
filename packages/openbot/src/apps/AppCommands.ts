import {
	AppCalls,
	Caller,
	CodeRuns,
	Execution,
	Vaults,
} from "@openbot-build/domain"
import { Client, McpClient } from "@openbot-build/protocol"
import { and, eq } from "drizzle-orm"
import {
	Array as Arr,
	Context,
	Crypto,
	Effect,
	Layer,
	Option,
	Schema,
} from "effect"
import { Hex } from "effect/encoding"
import { SqlClient } from "effect/sql"
import * as CallFrame from "../chats/CallFrame.ts"
import * as StoredChats from "../chats/StoredChats.ts"
import * as ToolOrigins from "../chats/ToolOrigins.ts"
import { TurnAccess } from "../chats/TurnAccess.ts"
import * as Db from "../database/Database.ts"
import {
	appExecutions,
	appInputs,
	executions,
} from "../database/ExecutionSchema.ts"
import { type Authorize, type Decide } from "../execution/Engine.ts"
import { Store, storage, type Fence, type Key } from "../execution/Store.ts"
import { Secrets } from "../secrets/Secrets.ts"
import { ActionPolicy } from "./ActionPolicy.ts"
import * as AppCall from "./AppCall.ts"

export const workflowName = "openbot.app-call"
export const Input = Schema.Struct({
	source: AppCalls.Source,
	arguments: Schema.JsonObject,
	toolName: Schema.String,
	reason: Schema.String,
	code: Schema.optionalKey(CodeRuns.RequestCode),
	vault: Schema.optionalKey(Schema.Array(Vaults.ReferenceBinding)),
})
export type Input = typeof Input.Type
const Saved = Schema.Struct({
	...Input.fields,
	site: Execution.CallSite,
	readOnly: Schema.Boolean,
})
const savedCodec = Schema.toCodecJson(Saved)
const Response = Schema.Struct({ actor: Caller, responses: Schema.JsonObject })
const responseCodec = Schema.fromJsonString(Response)
const outcomeCodec = Schema.toCodecJson(AppCalls.Outcome)
const aadCodec = Schema.fromJsonString(
	Schema.Tuple([Schema.String, Schema.String, Schema.Natural]),
)
export const inputDecision = (round: number) => `input:${round}`

/** A new input round resumes the original method, target and parameters. */
export const continuation = (
	input: Pick<Input, "source" | "arguments">,
	request: Schema.JsonObject,
): Client.Continuation => {
	switch (input.source.kind) {
		case "tool":
			return {
				method: "tools/call",
				params: { name: input.source.name, arguments: input.arguments },
				request,
			}
		case "resource":
			return {
				method: "resources/read",
				params: { uri: input.source.name },
				request,
			}
		case "template":
			return {
				method: "resources/read",
				params: { uriTemplate: input.source.name, values: input.arguments },
				request,
			}
		case "prompt":
			return {
				method: "prompts/get",
				params: { name: input.source.name, arguments: input.arguments },
				request,
			}
	}
}

const make = Effect.gen(function* () {
	const db = yield* Db.make
	const sql = yield* SqlClient.SqlClient
	const store = yield* Store
	const access = yield* TurnAccess
	const frames = yield* CallFrame.make
	const origins = yield* ToolOrigins.make
	const actions = yield* ActionPolicy
	const secrets = yield* Secrets
	const crypto = yield* Crypto.Crypto
	const where = (key: Key) =>
		and(
			eq(appExecutions.namespace, key.namespace),
			eq(appExecutions.executionId, key.id),
		)
	const load = Effect.fn("AppCommands.load")(function* (key: Key) {
		const execution = yield* store.loadMember(key)
		const row = Arr.head(
			yield* db.select().from(appExecutions).where(where(key)),
		)
		if (Option.isNone(row))
			return yield* Execution.NotFound.make({ id: key.id })
		const input = yield* Schema.decodeEffect(savedCodec)(execution.input)
		const origin = yield* origins.find(key)
		if (
			execution.workflow !== workflowName ||
			execution.record.resource.kind !== "AppCall" ||
			execution.record.resource.id !== row.value.id ||
			Option.isNone(origin) ||
			input.site.main !== origin.value.child.record.callId ||
			!Schema.toEquivalence(Schema.Array(Schema.String))(
				input.site.path,
				origin.value.path,
			)
		)
			return yield* Execution.Forbidden.make({})
		return {
			execution,
			input,
			origin: origin.value,
			id: AppCalls.AppOperationId.make(row.value.id),
			sourceKey: {
				namespace: key.namespace,
				id: Execution.Id.make(row.value.sourceExecutionId),
			},
		}
	}, storage)
	const authorize: Authorize = (key, actor, mode) =>
		load(key).pipe(Effect.andThen(access.authorize(key, actor, mode)))
	const submit = Effect.fn("AppCommands.submit")(function* (
		source: Fence,
		site: Execution.CallSite,
		input: Input,
	) {
		const origin = yield* frames.read(source, site)
		const found = yield* origins.find(source)
		if (Option.isNone(found)) return yield* Execution.Forbidden.make({})
		const path = yield* Schema.encodeEffect(
			Schema.fromJsonString(Schema.Array(Schema.String)),
		)([found.value.toolKey.id, site.main, ...site.path])
		const hash = Hex.encode(
			yield* crypto.digest("SHA-256", new TextEncoder().encode(path)),
		)
		return yield* store.accept(
			source.namespace,
			Execution.CommandKey.make(`app:${hash}`),
			{
				actor: origin.identity.actor,
				body: {
					source: source.id,
					site,
					input: yield* Schema.encodeEffect(Schema.toCodecJson(Input))(input),
				},
			},
			(create) =>
				Effect.gen(function* () {
					yield* StoredChats.lock(db, source.namespace, origin.position.chat)
					yield* access.authorize(source, origin.identity.actor, "advance")
					return yield* store.commit(
						source,
						{
							events: (child) => [
								{
									_tag: "ChildExecution",
									executionId: child.executionId,
									step: `app:${hash}`,
								},
							],
						},
						Effect.gen(function* () {
							const id = AppCalls.AppOperationId.make(
								yield* crypto.randomUUIDv4(),
							)
							const readOnly = yield* actions.isRead({
								organizationId: origin.identity.owner.organizationId,
								source: input.source,
							})
							const key = yield* create({
								workflow: workflowName,
								...(yield* store.ownership(source)),
								resource: { kind: "AppCall", id },
								identity: origin.identity,
								input: yield* Schema.encodeEffect(savedCodec)({
									...input,
									site,
									readOnly,
								}),
							})
							yield* origins.attach(source, key, site)
							yield* db.insert(appExecutions).values({
								namespace: key.namespace,
								executionId: key.id,
								sourceExecutionId: source.id,
								id,
							})
							return { executionId: key.id, start: true }
						}),
					)
				}),
		)
	}, storage)
	const aad = (key: Key, round: number) =>
		Schema.encodeEffect(aadCodec)([key.namespace, key.id, round]).pipe(
			Effect.map((value) => `app-input:${value}`),
		)
	const response = Effect.fn("AppCommands.response")(function* (
		key: Key,
		round: number,
	) {
		const row = Arr.head(
			yield* db
				.select()
				.from(appInputs)
				.where(
					and(
						eq(appInputs.namespace, key.namespace),
						eq(appInputs.executionId, key.id),
						eq(appInputs.round, round),
					),
				),
		)
		if (Option.isNone(row)) return Option.none()
		return Option.some(
			yield* secrets
				.open(row.value.body, yield* aad(key, round))
				.pipe(Effect.flatMap(Schema.decodeEffect(responseCodec))),
		)
	}, storage)
	/** The call log gives each round's result. There is no second sending state. */
	const current = Effect.fn("AppCommands.current")(function* (key: Key) {
		const saved = yield* load(key)
		const history = yield* store.calls(key)
		let next: AppCall.Input = {
			round: 0,
			source: saved.input.source,
			arguments: saved.input.arguments,
			readOnly: saved.input.readOnly,
		}
		let answer: Option.Option<typeof Response.Type> = Option.none()
		while (true) {
			const matching = Arr.filter(
				history,
				(call) => call.step === AppCall.stepId(next.round),
			)
			const call = Arr.findFirst(
				matching,
				(value) =>
					!Arr.some(matching, (other) => other.attempt > value.attempt),
			)
			if (
				Option.isSome(call) &&
				!Schema.toEquivalence(AppCall.Input)(
					yield* Schema.decodeEffect(Schema.toCodecJson(AppCall.Input))(
						call.value.input,
					),
					next,
				)
			)
				return yield* Execution.Conflict.make({ id: key.id })
			if (Option.isNone(call) || call.value.status !== "completed")
				return { _tag: "Send" as const, input: next, call, answer }
			const result = yield* Schema.decodeEffect(outcomeCodec)(call.value.result)
			if (result._tag !== "InputRequired")
				return {
					_tag: "Done" as const,
					round: next.round,
					result,
					call: call.value,
				}
			const round = next.round + 1
			answer = yield* response(key, round)
			if (Option.isNone(answer))
				return {
					_tag: "Input" as const,
					round,
					request: result.request,
					call: call.value,
				}
			next = {
				...next,
				round,
				continuation: {
					request: result.request,
					responses: answer.value.responses,
				},
			}
		}
	}, storage)
	/** Deliver results only after their scope closes. Input handoff is a saved decision. */
	const first = Effect.fn("AppCommands.first")(function* (key: Key) {
		const initial = yield* load(key)
		yield* authorize(key, initial.execution.identity.actor, "replay")
		return yield* sql.withTransaction(
			Effect.gen(function* () {
				// Result saves, cancellation and takeover use this same row lock.
				yield* db
					.select({ id: executions.id })
					.from(executions)
					.where(
						and(
							eq(executions.namespace, key.namespace),
							eq(executions.id, key.id),
						),
					)
					.for("update")
				const saved = yield* load(key)
				const execution = saved.execution.record
				const empty = {
					id: saved.id,
					execution,
					outcome: Option.none<AppCalls.Outcome>(),
				}
				const phase = yield* current(key)
				const round =
					phase._tag === "Send"
						? phase.input.round
						: phase._tag === "Input"
							? phase.round - 1
							: phase.round
				if (
					round === 0 &&
					(execution.status === "cancelling" ||
						execution.status === "outcome_unknown")
				)
					return empty
				const history = Arr.filter(
					yield* store.calls(key),
					(call) => call.step === AppCall.stepId(0),
				)
				const call = Arr.findFirst(
					history,
					(value) =>
						!Arr.some(history, (other) => other.attempt > value.attempt),
				)
				const outcome =
					Option.isSome(call) && call.value.status === "completed"
						? Option.some(
								yield* Schema.decodeEffect(outcomeCodec)(call.value.result),
							)
						: Option.none<AppCalls.Outcome>()
				if (
					Option.isSome(outcome) &&
					outcome.value._tag === "InputRequired" &&
					Option.isSome(yield* store.decision(key, inputDecision(1)))
				)
					return { ...empty, outcome }
				if (execution.status === "failed") {
					if (execution.failure === null)
						return yield* Execution.Conflict.make({ id: key.id })
					return {
						...empty,
						outcome: Option.some<AppCalls.Outcome>({
							_tag: "Failed",
							failure: execution.failure,
						}),
					}
				}
				return execution.status === "completed" ? { ...empty, outcome } : empty
			}),
		)
	}, storage)
	const view = Effect.fn("AppCommands.view")(function* (key: Key) {
		const saved = yield* load(key)
		const state = yield* current(key)
		const record = saved.execution.record
		return AppCalls.ExecutionView.make({
			id: saved.id,
			executionId: key.id,
			chat: saved.origin.child.record.position.chat,
			turn: saved.origin.child.record.position.turn,
			callId: saved.input.site.main,
			toolName: saved.input.toolName,
			source: saved.input.source,
			arguments: saved.input.arguments,
			readOnly: saved.input.readOnly,
			round: state._tag === "Send" ? state.input.round : state.round,
			status: record.status,
			result:
				state._tag === "Done"
					? state.result
					: state._tag === "Input"
						? { _tag: "InputRequired", request: state.request }
						: null,
			failure: record.failure,
			createdAt: record.createdAt,
			updatedAt: record.updatedAt,
		})
	}, storage)
	const respond = Effect.fn("AppCommands.respond")(function* (
		key: Key,
		actor: Caller,
		commandKey: Execution.CommandKey,
		round: number,
		responses: Schema.JsonObject,
	) {
		yield* authorize(key, actor, "decide")
		const change = { round, responses }
		const prior = yield* store.receipt(key.namespace, commandKey, {
			actor,
			body: {
				kind: "decision",
				executionId: key.id,
				decisionId: inputDecision(round),
				answer: "allow",
				actor,
				change,
			},
		})
		if (Option.isSome(prior)) return prior.value
		const validate = Effect.gen(function* () {
			const state = yield* current(key)
			if (state._tag !== "Input" || state.round !== round)
				return yield* Execution.Conflict.make({ id: key.id })
			const saved = yield* load(key)
			yield* McpClient.validateInputs(
				continuation(saved.input, state.request),
				responses,
			).pipe(
				Effect.catchTag("ClientError", () =>
					Effect.fail(Execution.Conflict.make({ id: key.id })),
				),
			)
		})
		return yield* store.decide(
			key,
			commandKey,
			inputDecision(round),
			"allow",
			actor,
			{
				input: change,
				apply: Effect.gen(function* () {
					yield* authorize(key, actor, "decide")
					yield* validate
					const body = yield* secrets.seal(
						yield* Schema.encodeEffect(responseCodec)({ actor, responses }),
						yield* aad(key, round),
					)
					yield* db.insert(appInputs).values({
						namespace: key.namespace,
						executionId: key.id,
						round,
						body,
					})
				}),
			},
		)
	}, storage)
	/** Input replies need their sealed response body. Only call recovery uses the common decision route. */
	const decide: Decide = (key, actor, input) =>
		Effect.gen(function* () {
			yield* authorize(key, actor, "decide")
			if (input.answer !== "retry" && input.answer !== "stop")
				return yield* Execution.Conflict.make({ id: key.id })
			const call = Arr.findFirst(yield* store.calls(key), (call) =>
				Execution.isCallDecision(input.decisionId, call.id),
			)
			if (
				Option.isNone(call) ||
				(call.value.retry !== "never" &&
					!(call.value.retry === "idempotent" && input.answer === "stop"))
			)
				return yield* Execution.Conflict.make({ id: key.id })
			return yield* store.decide(
				key,
				input.commandKey,
				input.decisionId,
				input.answer,
				actor,
				{ input: null, apply: authorize(key, actor, "decide") },
			)
		})
	/** Storage retries can enter the same phase again after its first commit. */
	const phase = Effect.fn("AppCommands.phase")(function* (
		fence: Fence,
		status: "waiting" | "running",
	) {
		return yield* sql.withTransaction(
			Effect.gen(function* () {
				yield* store.lock(fence)
				const saved = yield* store.loadMember(fence)
				if (
					saved.generation !== fence.generation ||
					(saved.record.status !== "waiting" &&
						saved.record.status !== "running")
				)
					return yield* Execution.Conflict.make({ id: fence.id })
				if (saved.record.status !== status)
					yield* store.commit(fence, { status }, Effect.void)
			}),
		)
	}, storage)

	const waitInput = Effect.fn("AppCommands.waitInput")(function* (
		fence: Fence,
		round: number,
	) {
		return yield* sql.withTransaction(
			Effect.gen(function* () {
				yield* store.lock(fence)
				const next = yield* current(fence)
				if (next._tag !== "Input" || next.round !== round) return false
				yield* phase(fence, "waiting")
				yield* store.requestDecision(fence, inputDecision(round), ["allow"])
				return true
			}),
		)
	}, storage)

	const finish = Effect.fn("AppCommands.finish")(function* (
		fence: Fence,
		end:
			| { readonly status: "completed" | "interrupted" }
			| { readonly status: "failed"; readonly failure: Execution.Failure }
			| { readonly status: "cancelled"; readonly epoch: number },
	) {
		const saved = yield* load(fence)
		const events = [
			{ _tag: "Result" as const, resource: saved.execution.record.resource },
		]
		if (end.status === "cancelled")
			yield* store.finishCancellation(fence, end.epoch, (status) =>
				Effect.succeed(status === "outcome_unknown" ? [] : events),
			)
		else {
			if (end.status === "completed") {
				const phase = yield* current(fence)
				if (phase._tag !== "Done")
					return yield* Execution.Conflict.make({ id: fence.id })
			}
			yield* store.commit(
				fence,
				{
					status: end.status,
					events,
					...(end.status === "failed" ? { failure: end.failure } : {}),
				},
				Effect.void,
			)
		}
		return yield* store.get(fence)
	}, storage)
	return {
		admit: access.admit,
		submit,
		load,
		authorize,
		current,
		view,
		first,
		respond,
		decide,
		phase,
		waitInput,
		finish,
	}
})
export class AppCommands extends Context.Service<
	AppCommands,
	Effect.Success<typeof make>
>()("@openbot-build/openbot/apps/AppCommands") {}
export const layer = Layer.effect(AppCommands, make)
