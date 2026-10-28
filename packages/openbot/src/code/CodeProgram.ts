import type { Paused } from "../execution/Admission.ts"
import { type Developers, CodeRuns, Execution } from "@openbot-build/domain"
import * as AppSecrets from "../vaults/AppSecrets.ts"
import {
	Array as Arr,
	Cause,
	Context,
	Effect,
	Layer,
	Number as Num,
	Option,
	Ref,
	Schema,
	Stream,
	String as Str,
} from "effect"
import { AppCommands } from "../apps/AppCommands.ts"
import { Records } from "../errors/Records.ts"
import * as Recovery from "../execution/Recovery.ts"
import { Calls } from "../execution/Calls.ts"
import { Observation } from "../execution/Observation.ts"
import { Store, type Fence, type Key } from "../execution/Store.ts"
import * as VaultCode from "../vaults/CodeMode.ts"
import { CodeCommands, programStep } from "./CodeCommands.ts"
import { Sandbox } from "./Sandbox.ts"
import type { Call } from "./Protocol.ts"

import { CallInput, Submitted } from "./CodeCall.ts"
const Settled = Schema.Union([
	Schema.Struct({
		index: Schema.Natural,
		ok: Schema.Literal(true),
		value: Schema.String,
	}),
	Schema.Struct({
		index: Schema.Natural,
		ok: Schema.Literal(false),
		error: Schema.String,
	}),
])
const submittedCodec = Schema.toCodecJson(Submitted)
const settledCodec = Schema.toCodecJson(Settled)
const outputCodec = Schema.toCodecJson(CodeRuns.Output)
const errorText = Schema.encodeEffect(
	Schema.fromJsonString(
		Schema.Struct({
			name: Schema.String,
			message: Schema.String,
			details: Schema.optionalKey(Schema.Json),
		}),
	),
)
const callStep = (index: number) => `code:${index}`
const resultStep = (index: number) => `result:${index}`

export interface Service {
	readonly run: (fence: Fence) => Effect.Effect<
		CodeRuns.Output,
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.NotFound
		| Paused
		| Developers.StorageFailure
		| {
				errorId: Execution.ErrorId
				category: Execution.Failure["category"]
		  }
	>
}

export class CodeProgram extends Context.Service<CodeProgram, Service>()(
	"@openbot-build/openbot/code/CodeProgram",
) {}

const make = Effect.gen(function* () {
	const commands = yield* CodeCommands
	const apps = yield* AppCommands
	const calls = yield* Calls
	const store = yield* Store
	const sandbox = yield* Sandbox
	const vault = yield* AppSecrets.make
	const observation = yield* Observation
	const errors = yield* Records
	const recovery = yield* Recovery.make
	const run = Effect.fn("CodeProgram.run")(function* (fence: Fence) {
		const saved = yield* commands.load(fence)
		const input = saved.input
		const reject = (
			index: number,
			name: string,
			message: string,
			details?: Schema.Json,
		) =>
			errorText({
				name,
				message,
				...(details === undefined ? {} : { details }),
			}).pipe(Effect.map((error) => ({ index, ok: false as const, error })))
		const submit = (call: Call) =>
			Effect.gen(function* () {
				const body = yield* Schema.encodeEffect(Schema.toCodecJson(CallInput))(
					call,
				)
				const sent = yield* calls.invoke(
					fence,
					{
						step: callStep(call.index),
						attempt: 0,
						retry: "local",
						input: body,
					},
					() =>
						recovery.storage(
							fence.id,
							Effect.gen(function* () {
								const binding = Arr.findFirst(
									input.bindings,
									(entry) => entry.alias === call.binding,
								)
								const args = Schema.decodeOption(
									Schema.fromJsonString(Schema.JsonObject),
								)(call.arguments)
								if (Option.isNone(binding) || Option.isNone(args))
									return yield* Schema.encodeEffect(submittedCodec)({
										_tag: "Rejected",
										name: "TypeError",
										message:
											"The call needs a known App name and an object of arguments.",
									})
								const references = VaultCode.find(args.value)
								if (
									Arr.some(
										references,
										({ alias, field }) =>
											binding.value.source.kind !== "tool" ||
											!Arr.some(
												input.vault,
												(entry) =>
													entry.alias === alias &&
													Arr.contains(entry.fields, field),
											),
									)
								)
									return yield* Schema.encodeEffect(submittedCodec)({
										_tag: "Rejected",
										name: "VaultDenied",
										message:
											"The call has a Vault reference that the program cannot use.",
									})
								const allowed = yield* vault
									.check(
										saved.execution.identity,
										binding.value.source,
										args.value,
										input.vault,
									)
									.pipe(
										Effect.as(true),
										Effect.catchTag("ExecutionForbidden", () =>
											Effect.succeed(false),
										),
									)
								if (!allowed)
									return yield* Schema.encodeEffect(submittedCodec)({
										_tag: "Rejected",
										name: "VaultDenied",
										message: "The Vault item does not allow this App call.",
									})
								const receipt = yield* apps.submit(
									fence,
									{
										main: input.site.main,
										path: [...input.site.path, "code", String(call.index)],
									},
									{
										source: binding.value.source,
										arguments: args.value,
										toolName: call.binding,
										reason: input.reason,
										code: {
											run: saved.id,
											index: call.index,
											code: input.code,
										},
										vault: input.vault,
									},
								)
								return yield* Schema.encodeEffect(submittedCodec)({
									_tag: "Child",
									executionId: receipt.executionId,
								})
							}),
						),
				)
				if (sent._tag === "Unknown")
					return yield* Execution.Conflict.make({ id: fence.id })
				return yield* Schema.decodeEffect(submittedCodec)(sent.result)
			})
		const settled = (call: Call, submitted: typeof Submitted.Type) =>
			Effect.gen(function* () {
				const history = yield* store.calls(fence)
				const previous = Arr.findFirst(
					history,
					(entry) =>
						entry.step === resultStep(call.index) &&
						entry.status === "completed",
				)
				if (Option.isSome(previous))
					return Option.some(
						yield* Schema.decodeEffect(settledCodec)(previous.value.result),
					)
				let result: typeof Settled.Type
				if (submitted._tag === "Rejected")
					result = yield* reject(call.index, submitted.name, submitted.message)
				else {
					const key = { namespace: fence.namespace, id: submitted.executionId }
					const first = yield* apps.first(key)
					const details = { executionId: key.id, operationId: first.id }
					if (Option.isNone(first.outcome)) {
						if (!Execution.isTerminal(first.execution.status))
							return Option.none<typeof Settled.Type>()
						result = yield* reject(
							call.index,
							"AppCallStopped",
							"The App call stopped.",
							details,
						)
					} else {
						const outcome = first.outcome.value
						switch (outcome._tag) {
							case "Completed":
								result = {
									index: call.index,
									ok: true,
									value: yield* Schema.encodeEffect(
										Schema.fromJsonString(Schema.Json),
									)(outcome.result),
								}
								break
							case "InputRequired":
								result = yield* reject(
									call.index,
									"AppInputRequired",
									"The App needs more input. Answer it outside the program.",
									{ ...details, request: outcome.request },
								)
								break
							case "Failed":
								result = yield* reject(
									call.index,
									outcome.failure.category === "forbidden"
										? "AppCallDenied"
										: "AppCallFailed",
									"The App call failed.",
									{ ...details, failure: outcome.failure },
								)
								break
						}
					}
				}
				const sent = yield* calls.invoke(
					fence,
					{
						step: resultStep(call.index),
						attempt: 0,
						retry: "local",
						input: yield* Schema.encodeEffect(submittedCodec)(submitted),
					},
					() => Schema.encodeEffect(settledCodec)(result),
				)
				if (sent._tag === "Unknown")
					return yield* Execution.Conflict.make({ id: fence.id })
				return Option.some(
					yield* Schema.decodeEffect(settledCodec)(sent.result),
				)
			})
		const wait = (key: Key) =>
			observation.observe(key, 0).pipe(
				Stream.takeUntilEffect(() =>
					apps
						.first(key)
						.pipe(
							Effect.map(
								(first) =>
									Option.isSome(first.outcome) ||
									Execution.isTerminal(first.execution.status),
							),
						),
				),
				Stream.runDrain,
			)
		const program = Effect.gen(function* () {
			while (true) {
				yield* commands.authorize(
					fence,
					saved.execution.identity.actor,
					"advance",
				)
				const currentLimits = yield* commands.enabled
				yield* commands.phase(fence, "running")
				let seen = 0
				let pending: ReadonlyArray<Key> = []
				const mismatch = yield* Ref.make(false)
				const recorded = Arr.filter(yield* store.calls(fence), (call) =>
					Str.startsWith("code:")(call.step),
				)
				const answerBatch = (batch: ReadonlyArray<Call>) =>
					Effect.gen(function* () {
						let ready: ReadonlyArray<typeof Settled.Type> = []
						for (const call of batch) {
							if (call.index !== seen) {
								yield* Ref.set(mismatch, true)
								return Option.none()
							}
							seen++
							const prior = Arr.findFirst(
								recorded,
								(entry) => entry.step === callStep(call.index),
							)
							if (
								Option.isSome(prior) &&
								!Schema.toEquivalence(CallInput)(
									yield* Schema.decodeEffect(Schema.toCodecJson(CallInput))(
										prior.value.input,
									),
									call,
								)
							) {
								yield* Ref.set(mismatch, true)
								return Option.none()
							}
							const submitted = yield* submit(call)
							const result = yield* settled(call, submitted)
							if (Option.isSome(result)) ready = Arr.append(ready, result.value)
							else if (submitted._tag === "Child")
								pending = Arr.append(pending, {
									namespace: fence.namespace,
									id: submitted.executionId,
								})
						}
						return pending.length === 0 ? Option.some(ready) : Option.none()
					})
				const failure = yield* Ref.make<
					Option.Option<
						Cause.Cause<Effect.Error<ReturnType<typeof answerBatch>>>
					>
				>(Option.none())
				const answer = (batch: ReadonlyArray<Call>) =>
					answerBatch(batch).pipe(
						Effect.catchCause((cause) =>
							Ref.set(failure, Option.some(cause)).pipe(
								Effect.as(Option.none()),
							),
						),
					)
				const outcome = yield* sandbox.run(
					{
						code: input.code,
						bindings: Arr.map(input.bindings, (binding) => binding.alias),
						vault: Arr.map(input.vault, ({ alias, fields }) => ({
							alias,
							fields,
						})),
						seed: input.seed,
						clock: input.clock,
						limits: {
							timeoutMs: Num.min(
								input.limits.timeoutMs,
								currentLimits.timeoutMs,
							),
							memoryBytes: Num.min(
								input.limits.memoryBytes,
								currentLimits.memoryBytes,
							),
							outputBytes: Num.min(
								input.limits.outputBytes,
								currentLimits.outputBytes,
							),
						},
					},
					answer,
				)
				const broken = yield* Ref.get(failure)
				if (Option.isSome(broken)) return yield* Effect.failCause(broken.value)
				if (
					(yield* Ref.get(mismatch)) ||
					(outcome._tag !== "Stopped" && recorded.length > seen)
				) {
					const failure = yield* errors.record(
						Cause.fail({
							_tag: "CodeReplayMismatch",
							seen,
							recorded: recorded.length,
						}),
						"conflict",
						fence.id,
					)
					return CodeRuns.Output.cases.Failed.make({
						reason: "ReplayMismatch",
						failure,
						logs: [],
					})
				}
				if (outcome._tag === "Done")
					return CodeRuns.Output.cases.Completed.make({
						value: outcome.value,
						logs: outcome.logs,
					})
				if (outcome._tag === "Failed") {
					const failure = yield* errors.record(
						Cause.fail(outcome),
						"invalid",
						fence.id,
					)
					return CodeRuns.Output.cases.Failed.make({
						reason: outcome.reason,
						failure,
						logs: outcome.logs,
					})
				}
				if (pending.length === 0)
					return yield* Execution.Conflict.make({ id: fence.id })
				// The worker is closed before the execution waits for App results or approval.
				yield* commands.phase(fence, "waiting")
				yield* Effect.forEach(pending, wait, {
					concurrency: "unbounded",
					discard: true,
				})
			}
		})
		const result = yield* calls.invoke(
			fence,
			{ step: programStep, attempt: 0, retry: "local", input: null },
			() =>
				recovery
					.storage(fence.id, program)
					.pipe(Effect.flatMap(Schema.encodeEffect(outputCodec))),
			commands.phase(fence, "running"),
		)
		if (result._tag === "Unknown")
			return yield* Execution.Conflict.make({ id: fence.id })
		return yield* Schema.decodeEffect(outputCodec)(result.result)
	})
	return CodeProgram.of({ run })
})

export const layer = Layer.effect(CodeProgram, make)
