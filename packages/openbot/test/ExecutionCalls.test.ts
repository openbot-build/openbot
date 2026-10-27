import * as ModelFailure from "../src/models/ModelFailure.ts"
import * as Send from "../src/execution/Send.ts"
import * as Admission from "../src/execution/Admission.ts"
import * as Observation from "../src/execution/Observation.ts"
import * as AppCall from "../src/apps/AppCall.ts"
import { Client } from "@openbot-build/protocol"
import { ConnectionId } from "@openbot-build/domain"
import { CallContext } from "../src/execution/CallContext.ts"
import {
	entry,
	Idempotent,
	Local,
	SavedResult,
} from "../src/plugins/ToolEntry.ts"
import * as ModelCalls from "../src/models/ModelCalls.ts"
import { NodeServices } from "@effect/platform-node"
import { assert, layer } from "@effect/vitest"
import {
	Chat,
	Item,
	Turn,
	Config,
	Model,
	Provider,
	ContextCompaction,
	ContextWindow,
	ChatStoreRepository,
	MemoryPersistence,
	Store as CoreStore,
	TurnRunner,
} from "@openbot-build/core"
import { Authorizer, Policy } from "@nmnmcc/ability"
import {
	Execution,
	Authorization,
	Bots as BotDomain,
} from "@openbot-build/domain"
import {
	Array as Arr,
	Cause,
	Context,
	Clock,
	Deferred,
	Fiber,
	Effect,
	Exit,
	Layer,
	Option,
	Redacted,
	Ref,
	Schema,
	Stream,
	String as Str,
} from "effect"
import {
	LanguageModel,
	DecisionModel,
	Decision,
	Prompt,
	Response,
	Tool,
	Toolkit,
} from "effect/ai"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as Records from "../src/errors/Records.ts"
import * as Report from "../src/errors/Report.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import * as Calls from "../src/execution/Calls.ts"
import * as CallRecovery from "../src/execution/CallRecovery.ts"
import { SqlError } from "effect/sql"
import * as Runner from "../src/execution/Runner.ts"
import * as RunScope from "../src/execution/RunScope.ts"
import * as Engine from "../src/execution/Engine.ts"
import { DurableDeferred, WorkflowEngine } from "effect/workflow"
import * as Store from "../src/execution/Store.ts"
import * as ToolSteps from "../src/chats/ToolSteps.ts"
import { TurnAccess } from "../src/chats/TurnAccess.ts"
import * as ModelSteps from "../src/chats/ModelSteps.ts"
import { Billing, BillingStorageError } from "../src/billing/Billing.ts"
import {
	CurrentAttribution,
	meter,
	meterDecision,
	CurrentCallIdentity,
} from "../src/billing/MeteredModel.ts"
import { Registry } from "../src/execution/Engine.ts"
import * as Judge from "../src/capabilities/Judge.ts"
import { ModelRegistry, AnyModel } from "../src/models/ModelRegistry.ts"
import * as BotFixture from "./BotFixture.ts"
import * as PostgresTest from "./PostgresTest.ts"

class Allowed extends Context.Service<Allowed, Ref.Ref<boolean>>()(
	"@openbot-build/openbot/test/ExecutionCalls.test/Allowed",
) {}
class AdvanceAllowed extends Context.Service<
	AdvanceAllowed,
	Ref.Ref<boolean>
>()("@openbot-build/openbot/test/ExecutionCalls.test/AdvanceAllowed") {}
class DecisionAllowed extends Context.Service<
	DecisionAllowed,
	Ref.Ref<boolean>
>()("@openbot-build/openbot/test/ExecutionCalls.test/DecisionAllowed") {}
const registry = Layer.effect(
	Registry,
	Effect.gen(function* () {
		const allowed = yield* Allowed
		const advance = yield* AdvanceAllowed
		const decide = yield* DecisionAllowed
		return Registry.of({
			register: () => Effect.void,
			registerService: () => Effect.void,
			names: Effect.succeed(["calls"]),
			get: () =>
				Effect.succeedSome({
					start: () => Effect.void,
					cancel: () => Effect.void,
					signal: () => Effect.void,
					authorize: (_, __, mode) =>
						Effect.gen(function* () {
							if (
								!(yield* Ref.get(allowed)) ||
								(mode === "advance" && !(yield* Ref.get(advance))) ||
								(mode === "decide" && !(yield* Ref.get(decide)))
							)
								return yield* Execution.Forbidden.make({})
						}),
				}),
		})
	}),
)
const database = Layer.effectDiscard(DatabasePostgres.migrate).pipe(
	Layer.provideMerge(
		Layer.unwrap(
			Effect.map(PostgresTest.start, (db) =>
				DatabasePostgres.layer({ databaseUrl: Redacted.make(db.url) }),
			),
		),
	),
)
const judgeAccess = Authorizer.layer(Authorization.Auth, {
	policy: () =>
		Effect.succeed(
			Policy.define(Authorization.OpenBot)(function* (_) {
				yield* _.allow("*", "*")
			}),
		),
})
const selection = Config.Selection.make({
	provider: Provider.Id.make("provider"),
	model: Model.Id.make("model"),
})
const services = ToolSteps.layer.pipe(
	Layer.provideMerge(
		Layer.mock(TurnAccess, {
			admit: () => Effect.void,
			model: () => Effect.void,
		}),
	),
	Layer.provideMerge(Layer.mergeAll(Calls.layer, Send.layer)),
	Layer.provideMerge(
		Layer.mock(Billing, {
			record: () => Effect.void,
			unknown: () => Effect.void,
			releaseExecution: () => Effect.succeed(true),
		}),
	),
	Layer.provideMerge(Observation.layer),
	Layer.provideMerge(Layer.mergeAll(Store.layer, Records.layer, registry)),
	Layer.provideMerge(Layer.effect(Allowed, Ref.make(true))),
	Layer.provideMerge(Layer.effect(AdvanceAllowed, Ref.make(true))),
	Layer.provideMerge(Layer.effect(DecisionAllowed, Ref.make(true))),
	Layer.provide(Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11")))),
	Layer.provideMerge(database),
	Layer.provideMerge(NodeServices.layer),
)
const actor = { kind: "member", organizationId: "org", userId: "user" } as const
const start = Effect.fn(function* (namespace: string) {
	const store = yield* Store.Store
	const receipt = yield* store.submit(
		namespace,
		Execution.CommandKey.make("start"),
		{
			workflow: "calls",
			resource: { kind: "Chat", id: namespace },
			identity: { owner: actor, actor },
			input: null,
		},
	)
	return yield* store.takeOver({ namespace, id: receipt.executionId })
})
const input = {
	step: "write",
	attempt: 0,
	retry: "never",
	input: { text: "private input" },
} as const
layer(services, { excludeTestServices: true, timeout: "60 seconds" })((it) => {
	for (const outcome of ["not_sent", "not_sent_retry", "unknown"] as const) {
		it.effect(`a Live model keeps a ${outcome} outcome through takeover`, () =>
			Effect.gen(function* () {
				const fence = yield* start(`model-${outcome}`)
				const writes = yield* Ref.make(0)
				const billing = yield* Billing
				const models = yield* ModelCalls.make.pipe(
					Effect.provideService(
						Billing,
						Billing.of({
							...billing,
							unknown: (id) =>
								Ref.updateAndGet(writes, (n) => n + 1).pipe(
									Effect.flatMap((n) =>
										outcome === "not_sent_retry" && n === 1
											? Effect.fail(
													BillingStorageError.make({
														cause: "The ledger lost the connection.",
														retryable: true,
													}),
												)
											: billing.unknown(id),
									),
								),
						}),
					),
				)
				const store = yield* Store.Store
				const sends = yield* Ref.make(0)
				const failure = yield* (yield* Records.Records).record(
					Cause.fail("The model refused the call."),
					"forbidden",
					fence.id,
				)
				const run = (owner: Store.Fence) =>
					models.run(owner, "model", null, {
						codec: Schema.Null,
						retry: "never",
						beforeSend: Effect.void,
						send: () =>
							Ref.update(sends, (n) => n + 1).pipe(
								Effect.andThen(
									Effect.fail(
										outcome !== "unknown"
											? ModelFailure.notSent(failure)
											: failure,
									),
								),
							),
						usage: () =>
							Response.Usage.make({
								inputTokens: {
									total: 0,
									uncached: 0,
									cacheRead: 0,
									cacheWrite: 0,
								},
								outputTokens: { total: 0, text: 0, reasoning: 0 },
							}),
					})
				const first = yield* run(fence).pipe(Effect.flip)
				if (outcome !== "unknown") assert.deepEqual(first, failure)
				else assert.isTrue(Schema.is(Execution.OutcomeUnknown)(first))
				const next = yield* store.takeOver(fence)
				const second = yield* run(next).pipe(Effect.flip)
				assert.deepEqual(second, first)
				assert.equal(yield* Ref.get(sends), 1)
				if (outcome === "not_sent_retry")
					assert.isAtLeast(yield* Ref.get(writes), 2)
				const saved = Option.getOrThrow(
					Arr.findFirst(
						yield* store.calls(fence),
						(call) => call.step === "model",
					),
				)
				assert.equal(
					saved.status,
					outcome !== "unknown" ? "completed" : "outcome_unknown",
				)
			}),
		)
	}

	for (const failureKind of ["failure", "defect"] as const)
		it.effect(
			`an unknown tool ${failureKind} stays pending instead of becoming a model result`,
			() =>
				Effect.gen(function* () {
					const store = yield* Store.Store
					const steps = yield* ToolSteps.ToolSteps
					const records = yield* Records.Records
					const fence = yield* start("tool-unknown-result-" + failureKind)
					const failure = yield* records.record(
						Cause.fail("The reply was lost."),
						"outcome_unknown",
						fence.id,
					)
					const sends = yield* Ref.make(0)
					const selected = entry(
						"send",
						"Send a message.",
						{ type: "object", properties: {} },
						() =>
							Ref.update(sends, (n) => n + 1).pipe(
								Effect.andThen(
									failureKind === "defect"
										? Effect.die("The adapter lost the reply.")
										: Effect.fail(failure),
								),
							),
						{ records, executionId: fence.id },
					)
					const toolkit = Toolkit.make(selected.tool)
					const handlers = yield* toolkit.toHandlers({ send: selected.handle })
					const ready = yield* toolkit.pipe(Effect.provideContext(handlers))
					const position = {
						chat: Chat.Id.make("chat"),
						turn: Turn.Id.make("turn"),
						item: Item.Id.make("item"),
						step: 0,
					}
					const call = Prompt.toolCallPart({
						id: "send",
						name: "send",
						params: {},
						providerExecuted: false,
					})
					const run = steps.run(fence, position, { call, toolkit: ready }, () =>
						Effect.die("An unknown write has no final output."),
					)
					assert.ok(
						Schema.is(Execution.OutcomeUnknown)(yield* run.pipe(Effect.flip)),
					)
					assert.ok(
						Schema.is(Execution.OutcomeUnknown)(yield* run.pipe(Effect.flip)),
					)
					assert.equal(yield* Ref.get(sends), 1)
					assert.equal(
						(yield* store.calls(fence))[0]?.status,
						"outcome_unknown",
					)
				}).pipe(Effect.scoped),
		)

	it.effect(
		"a remote send uses the saved call identity and checks current access",
		() =>
			Effect.gen(function* () {
				const store = yield* Store.Store
				const calls = yield* Calls.Calls
				const access = yield* Send.Access
				const fence = yield* start("remote-authority")
				const result = yield* calls.invoke(fence, input, () =>
					Effect.gen(function* () {
						// The request identity cannot replace the identity of this saved call.
						const authority = yield* Send.authority({
							owner: actor,
							actor: { ...actor, userId: "other" },
						})
						assert.equal(authority._tag, "Call")
						assert.deepEqual(yield* access.resolve(authority), {
							owner: {
								organizationId: actor.organizationId,
								userId: actor.userId,
							},
							actor,
						})
						const allowed = yield* AdvanceAllowed
						yield* Ref.set(allowed, false)
						assert.ok(
							Schema.is(Execution.Forbidden)(
								yield* access.resolve(authority).pipe(Effect.flip),
							),
						)
						yield* Ref.set(allowed, true)
						return null
					}),
				)
				assert.equal(result._tag, "Completed")
				const call = (yield* store.calls(fence))[0]!
				assert.ok(
					Schema.is(Execution.Conflict)(
						yield* access
							.resolve(
								Send.Authority.cases.Call.make({
									reference: { ...fence, callId: call.id },
								}),
							)
							.pipe(Effect.flip),
					),
				)
			}),
	)

	for (const stop of ["takeover", "cancel"] as const)
		it.effect(`a remote send cannot use an old permit after ${stop}`, () =>
			Effect.gen(function* () {
				const store = yield* Store.Store
				const access = yield* Send.Access
				const fence = yield* start(`remote-permit-${stop}`)
				const call = yield* store.intent(fence, input)
				yield* store.sending(fence, call.id)
				const authority = Send.Authority.cases.Call.make({
					reference: { ...fence, callId: call.id },
				})
				assert.deepEqual(yield* access.resolve(authority), {
					owner: { organizationId: actor.organizationId, userId: actor.userId },
					actor,
				})
				if (stop === "takeover") yield* store.takeOver(fence)
				else
					yield* store.cancel(fence, Execution.CommandKey.make("cancel"), actor)
				assert.ok(
					Schema.is(Execution.Conflict)(
						yield* access.resolve(authority).pipe(Effect.flip),
					),
				)
			}),
		)
	it.effect("a runner saves failure before the feature starts to release", () =>
		Effect.gen(function* () {
			const key = yield* start("runner-failure-before-close")
			const store = yield* Store.Store
			const calls = yield* Calls.Calls
			const runner = yield* Runner.Runner
			yield* runner.run(
				key,
				(fence) =>
					store
						.readAttempt(fence, "model", null)
						.pipe(Effect.andThen(Effect.fail(Execution.Forbidden.make({})))),
				(fence, failure) =>
					Effect.gen(function* () {
						const saved = yield* store.load(fence)
						assert.isTrue(saved.phaseFailed)
						assert.deepEqual(saved.record.failure, failure)
						assert.equal(failure.category, "forbidden")
						const call = Option.getOrThrow(Arr.head(yield* store.calls(fence)))
						// A failed owner cannot admit another provider call while close is still in progress.
						assert.isTrue(
							Schema.is(Execution.Conflict)(
								yield* calls
									.reserve(fence, call, Effect.void)
									.pipe(Effect.flip),
							),
						)
						yield* store.transition(fence, "failed", failure)
					}),
			)
			assert.equal((yield* store.get(key)).status, "failed")
		}).pipe(Effect.provide(Runner.layer)),
	)
	it.effect(
		"a failed release keeps its own cause and the first work failure",
		() =>
			Effect.gen(function* () {
				const key = yield* start("runner-release-cause")
				const store = yield* Store.Store
				const records = yield* Records.Records
				const saved = yield* Ref.make<
					ReadonlyArray<{
						readonly cause: Cause.Cause<unknown>
						readonly failure: Execution.Failure
						readonly executionId: Execution.Id | undefined
					}>
				>([])
				const ends = yield* Ref.make<
					ReadonlyArray<{
						readonly status: Execution.Status
						readonly failure: Execution.Failure
					}>
				>([])
				yield* Effect.gen(function* () {
					const runner = yield* Runner.Runner
					yield* runner.run(
						key,
						() => Effect.fail(Execution.Forbidden.make({})),
						(fence, failure) =>
							Effect.gen(function* () {
								const status = (yield* store.get(key)).status
								const attempts = yield* Ref.updateAndGet(ends, (values) => [
									...values,
									{ status, failure },
								])
								if (attempts.length === 1)
									return yield* Effect.die("The test resource did not close")
								yield* store.transition(fence, "failed", failure)
							}),
					)
				}).pipe(
					Effect.provide(
						Layer.fresh(
							Runner.layer.pipe(
								Layer.provide(
									Layer.succeed(Records.Records, {
										record: (cause, category, executionId) =>
											records
												.record(cause, category, executionId)
												.pipe(
													Effect.tap((failure) =>
														Ref.update(saved, (values) => [
															...values,
															{ cause, failure, executionId },
														]),
													),
												),
									}),
								),
							),
						),
					),
				)
				const failures = yield* Ref.get(saved)
				assert.equal(failures.length, 2)
				assert.equal(failures[0]?.failure.category, "forbidden")
				assert.isTrue(Cause.hasDies(failures[1]!.cause))
				assert.notEqual(
					failures[0]?.failure.errorId,
					failures[1]?.failure.errorId,
				)
				assert.isTrue(
					Arr.every(failures, (failure) => failure.executionId === key.id),
				)
				const attempts = yield* Ref.get(ends)
				assert.equal(attempts.length, 2)
				// A failed close keeps the execution open and retains the first work failure.
				assert.isTrue(
					Arr.every(attempts, (attempt) => attempt.status === "running"),
				)
				assert.deepEqual(attempts[0]?.failure, failures[0]?.failure)
				assert.deepEqual(attempts[1]?.failure, failures[0]?.failure)
				assert.deepEqual((yield* store.get(key)).failure, failures[0]?.failure)
				assert.equal((yield* store.get(key)).status, "failed")
			}),
	)

	for (const other of ["rights", "pause"] as const)
		it.effect(`a reservation keeps both SQL and ${other} failure causes`, () =>
			Effect.gen(function* () {
				const fence = yield* start(`reservation-cause-${other}`)
				const store = yield* Store.Store
				const calls = yield* Calls.Calls
				const call = yield* store.readAttempt(fence, "model", null)
				const database = SqlError.SqlError.make({
					reason: SqlError.ConnectionError.make({
						cause: "The connection was lost.",
					}),
				})
				const domain =
					other === "rights"
						? Execution.Forbidden.make({})
						: Admission.Paused.make({
								...fence,
								afterSequence: Execution.Sequence.make(0),
							})
				const cause =
					other === "rights"
						? Cause.combine(Cause.fail(database), Cause.fail(domain))
						: Cause.combine(Cause.fail(domain), Cause.fail(database))
				const attempts = yield* Ref.make(0)
				const result = yield* calls
					.reserve(
						fence,
						call,
						Ref.update(attempts, (n) => n + 1).pipe(
							Effect.andThen(Effect.failCause(cause)),
						),
					)
					.pipe(Effect.exit)
				assert.equal(yield* Ref.get(attempts), 1)
				assert.isTrue(Exit.isFailure(result))
				if (Exit.isFailure(result)) {
					assert.equal(result.cause.reasons.length, 2)
					const recorded = Arr.flatMap(result.cause.reasons, (reason) =>
						reason._tag === "Fail" &&
						Schema.is(Execution.StorageError)(reason.error)
							? [reason.error]
							: [],
					)
					assert.equal(recorded.length, 1)
					assert.deepEqual(recorded[0]?.cause, cause)
					assert.isTrue(
						Arr.some(
							result.cause.reasons,
							(reason) => reason._tag === "Fail" && reason.error === domain,
						),
					)
				}
			}),
		)
	const appInput: AppCall.Input = {
		round: 0,
		readOnly: false,
		source: {
			connectionId: ConnectionId.make("connection"),
			connectionName: "Notes",
			cardUrl: "https://app.example",
			appName: "Notes",
			remoteIndex: 0,
			revision: 1,
			kind: "tool",
			name: "write",
			definition: {},
		},
		arguments: { text: "private App input" },
	}
	const appDone = Effect.succeed({
		_tag: "Completed",
		result: { saved: true },
	} as const)

	it.effect(
		"an unknown App write uses the common decision and never becomes a completed failure",
		() =>
			Effect.gen(function* () {
				const app = yield* AppCall.make
				const store = yield* Store.Store
				const calls = yield* Calls.Calls
				const fence = yield* start("app-unknown")
				const sent = yield* Ref.make(0)
				const lost = Ref.update(sent, (n) => n + 1).pipe(
					Effect.andThen(
						Effect.fail(
							Client.OutcomeUnknown.make({
								key: { owner: "user", connectionId: "connection" },
								target: "write",
								cause: "Network",
							}),
						),
					),
				)
				const first = yield* app.invoke(fence, appInput, lost, Effect.void)
				assert.equal(first._tag, "Unknown")
				assert.deepEqual(
					yield* app.invoke(fence, appInput, appDone, Effect.void),
					first,
				)
				assert.equal((yield* store.calls(fence))[0]?.status, "outcome_unknown")
				assert.equal(yield* Ref.get(sent), 1)
				assert.equal(
					(yield* calls.recover(fence, first.callId))._tag,
					"Pending",
				)
				yield* store.decide(
					fence,
					Execution.CommandKey.make("retry"),
					first.callId,
					"retry",
					actor,
				)
				yield* calls.recover(fence, first.callId)
				const next = yield* store.takeOver(fence)
				const answer = yield* app.invoke(
					next,
					appInput,
					Ref.update(sent, (n) => n + 1).pipe(Effect.andThen(appDone)),
					Effect.void,
				)
				assert.equal(answer._tag, "Completed")
				assert.notEqual(answer.callId, first.callId)
				assert.equal(yield* Ref.get(sent), 2)
				assert.deepEqual(
					Arr.map(yield* store.calls(next), (call) => [
						call.attempt,
						call.status,
					]),
					[
						[0, "outcome_unknown"],
						[1, "completed"],
					],
				)
			}),
	)

	it.effect(
		"App business failures keep an error ID without exposing the provider error",
		() =>
			Effect.gen(function* () {
				const app = yield* AppCall.make
				const store = yield* Store.Store
				const fence = yield* start("app-business-failure")
				const result = yield* app.invoke(
					fence,
					appInput,
					Effect.fail(
						Client.ToolFailure.make({
							result: {
								isError: true,
								content: [{ type: "text", text: "private provider failure" }],
							},
						}),
					),
					Effect.void,
				)
				assert.equal(result._tag, "Completed")
				if (result._tag !== "Completed" || result.result._tag !== "Failed")
					return assert.fail("Expected a safe App failure")
				assert.equal(result.result.failure.category, "external")
				assert.isNotEmpty(result.result.failure.errorId)
				assert.notInclude(
					yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
						result,
					),
					"private provider failure",
				)
				const next = yield* store.takeOver(fence)
				assert.deepEqual(
					yield* app.invoke(
						next,
						appInput,
						Effect.die("A saved failure must not send again"),
						Effect.void,
					),
					result,
				)
			}),
	)

	for (const error of [
		Client.PermissionDenied.make({
			action: "invoke",
			target: "private target",
		}),
		Client.ClientError.make({
			reason: "Schema",
			issue: "private schema issue",
		}),
	])
		it.effect(
			`a known App ${error._tag} is saved without an unknown write`,
			() =>
				Effect.gen(function* () {
					const app = yield* AppCall.make
					const store = yield* Store.Store
					const fence = yield* start("app-known-" + error._tag)
					const result = yield* app.invoke(
						fence,
						appInput,
						Effect.fail(error),
						Effect.void,
					)
					assert.equal(result._tag, "Completed")
					assert.equal((yield* store.calls(fence))[0]?.status, "completed")
					assert.notInclude(
						yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
							result,
						),
						"private",
					)
				}),
		)

	it.effect(
		"a read App failure gets a new attempt and a saved result still checks access",
		() =>
			Effect.gen(function* () {
				const app = yield* AppCall.make
				const store = yield* Store.Store
				const fence = yield* start("app-read-retry")
				const request = { ...appInput, readOnly: true }
				const failed = yield* app
					.invoke(
						fence,
						request,
						Effect.fail(
							Client.ClientError.make({
								reason: "Network",
								issue: "Lost response",
							}),
						),
						Effect.void,
					)
					.pipe(Effect.flip)
				assert.ok(Schema.is(Execution.Failure)(failed))
				const next = yield* store.takeOver(fence)
				const answer = yield* app.invoke(next, request, appDone, Effect.void)
				assert.equal(answer._tag, "Completed")
				assert.deepEqual(
					Arr.map(yield* store.calls(next), (call) => call.attempt),
					[0, 1],
				)
				const allowed = yield* Allowed
				yield* Ref.set(allowed, false)
				assert.ok(
					Schema.is(Execution.Forbidden)(
						yield* app
							.invoke(next, request, appDone, Effect.void)
							.pipe(Effect.flip, Effect.ensuring(Ref.set(allowed, true))),
					),
				)
			}),
	)

	it.effect(
		"a known App response is kept while its database save retries",
		() =>
			Effect.gen(function* () {
				const store = yield* Store.Store
				const fence = yield* start("app-result-save")
				const writes = yield* Ref.make(0)
				const sends = yield* Ref.make(0)
				const flaky = Store.Store.of({
					...store,
					finishCall: (...args) =>
						Effect.gen(function* () {
							if ((yield* Ref.getAndUpdate(writes, (n) => n + 1)) === 0)
								return yield* Execution.StorageError.make({
									cause: "Lost result write",
								})
							return yield* store.finishCall(...args)
						}),
				})
				const result = yield* Effect.gen(function* () {
					const app = yield* AppCall.make
					return yield* app.invoke(
						fence,
						appInput,
						Ref.update(sends, (n) => n + 1).pipe(Effect.andThen(appDone)),
						Effect.void,
					)
				}).pipe(
					Effect.provide(
						Calls.layer.pipe(
							Layer.fresh,
							Layer.provide(Layer.succeed(Store.Store, flaky)),
						),
					),
				)
				assert.equal(result._tag, "Completed")
				assert.equal(yield* Ref.get(sends), 1)
				assert.equal(yield* Ref.get(writes), 2)
			}),
	)

	it.effect(
		"App input rounds keep the original request and do not call its local responder",
		() =>
			Effect.gen(function* () {
				const app = yield* AppCall.make
				const store = yield* Store.Store
				const fence = yield* start("app-input-rounds")
				const request = {
					resultType: "input_required",
					requestState: "private request state",
					inputRequests: {
						consent: {
							method: "elicitation/create",
							params: {
								message: "Confirm the write",
								requestedSchema: {
									type: "object",
									properties: { confirmed: { type: "boolean" } },
									required: Arr.make("confirmed"),
								},
							},
						},
					},
				} as const
				const pending: Client.OperationResult<unknown> = {
					_tag: "InputRequired",
					result: request,
					respond: () => Effect.die("Do not keep the old responder"),
					handle: Effect.die("Do not run a local input handler"),
				}
				const first = yield* app.invoke(
					fence,
					appInput,
					Effect.succeed(pending),
					Effect.void,
				)
				assert.equal(first._tag, "Completed")
				if (first._tag !== "Completed")
					return assert.fail("Expected the saved input request")
				assert.deepEqual(first.result, { _tag: "InputRequired", request })
				const next = yield* store.takeOver(fence)
				assert.deepEqual(
					yield* app.invoke(
						next,
						appInput,
						Effect.die("Do not repeat the first request"),
						Effect.void,
					),
					first,
				)
				const continuation = {
					...appInput,
					round: 1,
					continuation: {
						request: yield* Schema.decodeEffect(Schema.JsonObject)(request),
						responses: {
							consent: { action: "accept", content: { confirmed: true } },
						},
					},
				}
				const result = yield* app.invoke(
					next,
					continuation,
					appDone,
					Effect.void,
				)
				assert.equal(result._tag, "Completed")
				assert.deepEqual(
					Arr.map(yield* store.calls(next), (call) => call.step),
					["app:0", "app:1"],
				)
				const changed = {
					...continuation,
					continuation: {
						...continuation.continuation,
						responses: { consent: { action: "cancel" } },
					},
				}
				assert.ok(
					Schema.is(Execution.Conflict)(
						yield* app
							.invoke(next, changed, appDone, Effect.void)
							.pipe(Effect.flip),
					),
				)
				assert.ok(
					Schema.is(Execution.Conflict)(
						yield* app
							.invoke(next, { ...appInput, round: 2 }, appDone, Effect.void)
							.pipe(Effect.flip),
					),
				)
			}),
	)

	for (const change of [
		"rights",
		"model rights",
		"pause",
		"cancel",
		"takeover",
		"storage",
		"usage storage",
	] as const)
		it.effect(
			`a model waiting for tokens checks ${change} before its reservation`,
			() =>
				Effect.gen(function* () {
					const fence = yield* start(`provider-check-${change}`)
					const store = yield* Store.Store
					const waiting = yield* Deferred.make<void>()
					const release = yield* Deferred.make<void>()
					const paused = yield* Deferred.make<void>()
					const changed = yield* Ref.make(false)
					const failures = yield* Ref.make(0)
					const reserved = yield* Ref.make(0)
					const sends = yield* Ref.make(0)
					const registry = yield* Registry
					const guarded = Registry.of({
						...registry,
						get: (name) =>
							registry.get(name).pipe(
								Effect.map(
									Option.map((feature) => ({
										...feature,
										admit: (key: Store.Key, lock: boolean) =>
											Effect.gen(function* () {
												if (lock) yield* store.hold(key)
												if (
													change === "storage" &&
													(yield* Ref.get(changed)) &&
													(yield* Ref.updateAndGet(failures, (n) => n + 1)) ===
														1
												)
													return yield* Execution.StorageError.make({
														cause:
															"The connection was lost before reservation.",
													})
												if (change === "pause" && (yield* Ref.get(changed)))
													return yield* Admission.Paused.make({
														...key,
														afterSequence: Execution.Sequence.make(0),
														wake: "limit:0",
													})
											}),
									})),
								),
							),
					})
					const billing = Layer.mock(Billing, {
						reserve: () =>
							Effect.gen(function* () {
								if (
									change === "usage storage" &&
									(yield* Ref.updateAndGet(failures, (n) => n + 1)) === 1
								)
									return yield* BillingStorageError.make({
										cause: "The budget read lost its connection.",
										retryable: true,
									})
								yield* Ref.update(reserved, (n) => n + 1)
								const identity = yield* CurrentCallIdentity
								assert.ok(identity)
								return { id: identity.id, startedAt: 0 }
							}),
						record: () => Effect.void,
						unknown: () => Effect.void,
					})
					const run = Effect.gen(function* () {
						const models = yield* ModelCalls.make
						const language = meter(
							yield* LanguageModel.make({
								generateText: () =>
									Ref.update(sends, (n) => n + 1).pipe(
										Effect.as([
											Response.makePart("finish", {
												reason: "stop",
												usage: Response.Usage.make({
													inputTokens: {
														total: 0,
														uncached: 0,
														cacheRead: 0,
														cacheWrite: 0,
													},
													outputTokens: { total: 0, text: 0, reasoning: 0 },
												}),
											}),
										]),
									),
								streamText: () => Stream.empty,
							}),
							{
								organizationId: "org",
								providerId: "provider",
								providerOwner: "organization",
								modelId: "model",
							},
							{
								billing: yield* Billing,
								report: yield* Report.make,
								throttle: {
									scopes: () => Effect.succeed([]),
									take: () =>
										Deferred.succeed(waiting, undefined).pipe(
											Effect.andThen(Deferred.await(release)),
										),
									charge: () => Effect.succeed(0),
								},
							},
						)
						return yield* models.run(fence, "model", null, {
							codec: Schema.Null,
							send: () =>
								language
									.generateText({ prompt: "Read the task." })
									.pipe(Effect.as(null)),
							usage: () =>
								Response.Usage.make({
									inputTokens: {
										total: 0,
										uncached: 0,
										cacheRead: 0,
										cacheWrite: 0,
									},
									outputTokens: { total: 0, text: 0, reasoning: 0 },
								}),
							beforeSend: Effect.gen(function* () {
								if (change === "model rights" && (yield* Ref.get(changed)))
									return yield* Execution.Forbidden.make({})
							}),
						})
					}).pipe(
						Effect.provide(
							Layer.mergeAll(
								billing,
								Calls.layer.pipe(
									Layer.provide(Layer.succeed(Registry, guarded)),
									Layer.fresh,
								),
							),
						),
						Effect.provideService(Admission.CurrentPhase, () =>
							Deferred.succeed(paused, undefined).pipe(
								Effect.andThen(Effect.never),
							),
						),
					)
					const running = yield* run.pipe(Effect.exit, Effect.forkScoped)
					yield* Deferred.await(waiting)
					yield* Ref.set(changed, true)
					if (change === "rights") yield* Ref.set(yield* AdvanceAllowed, false)
					if (change === "cancel")
						yield* store.cancel(
							fence,
							Execution.CommandKey.make("cancel"),
							actor,
						)
					if (change === "takeover") yield* store.takeOver(fence)
					yield* Deferred.succeed(release, undefined)
					if (change === "pause") {
						yield* Deferred.await(paused)
						const wakes = Arr.filter(
							yield* store.events(fence, 0),
							(event) => event.body._tag === "Wake",
						)
						assert.equal(wakes.length, 1)
						yield* store.wake(fence, "limit:0")
						assert.equal(
							Arr.filter(
								yield* store.events(fence, 0),
								(event) => event.body._tag === "Wake",
							).length,
							1,
						)
						// A pause must release its transaction before waiting, even inside acquisition.
						yield* store
							.cancel(fence, Execution.CommandKey.make("cancel-paused"), actor)
							.pipe(Effect.timeout("2 seconds"))
						yield* Fiber.interrupt(running).pipe(Effect.timeout("2 seconds"))
					} else {
						const result = yield* Fiber.join(running)
						assert.equal(
							Exit.isSuccess(result),
							change === "storage" || change === "usage storage",
						)
					}
					const count =
						change === "storage" || change === "usage storage" ? 1 : 0
					assert.equal(yield* Ref.get(reserved), count)
					assert.equal(yield* Ref.get(sends), count)
				}).pipe(
					Effect.scoped,
					Effect.ensuring(
						Effect.flatMap(AdvanceAllowed, (ref) => Ref.set(ref, true)),
					),
				),
		)
	for (const kind of ["language", "decision"] as const)
		it.effect(
			`failed ${kind} output repairs usage before returning a safe failure`,
			() =>
				Effect.gen(function* () {
					const fence = yield* start(`failed-${kind}-usage`)
					const writes = yield* Ref.make(0)
					const sends = yield* Ref.make(0)
					const billing = Layer.mock(Billing, {
						reserve: () =>
							Effect.gen(function* () {
								const identity = yield* CurrentCallIdentity
								assert.ok(identity)
								return { id: identity.id, startedAt: 0 }
							}),
						unknown: () => Effect.void,
						record: () =>
							Ref.updateAndGet(writes, (n) => n + 1).pipe(
								Effect.flatMap((n) =>
									n < 3
										? Effect.fail(
												BillingStorageError.make({
													cause: "The database is down.",
													retryable: true,
												}),
											)
										: Effect.void,
								),
							),
					})
					yield* Effect.gen(function* () {
						const models = yield* ModelCalls.make
						const accounting = {
							billing: yield* Billing,
							report: yield* Report.make,
							throttle: {
								scopes: () => Effect.succeed([]),
								take: () => Effect.void,
								charge: () => Effect.succeed(0),
							},
						}
						const language = meter(
							yield* LanguageModel.make({
								generateText: () =>
									Ref.update(sends, (n) => n + 1).pipe(
										Effect.as([
											Response.makePart("text", { text: "not JSON" }),
											Response.makePart("finish", {
												reason: "stop",
												usage: Response.Usage.make({
													inputTokens: {
														total: 10,
														uncached: 10,
														cacheRead: 0,
														cacheWrite: 0,
													},
													outputTokens: { total: 5, text: 5, reasoning: 0 },
												}),
											}),
										]),
									),
								streamText: () => Stream.empty,
							}),
							{
								organizationId: "org",
								providerId: "provider",
								providerOwner: "organization",
								modelId: "model",
							},
							accounting,
						)
						const decision = meterDecision(
							yield* DecisionModel.make({
								decide: () =>
									Ref.update(sends, (n) => n + 1).pipe(
										Effect.as({
											answers: { allowed: { _tag: "Refusal" as const } },
											usage: { inputTokens: 10, outputTokens: 5 },
										}),
									),
							}),
							{
								organizationId: "org",
								providerId: "provider",
								providerOwner: "organization",
								modelId: "model",
							},
							accounting,
						)
						const send =
							kind === "language"
								? language
										.generateObject({
											prompt: "Decide.",
											schema: Schema.Struct({ allowed: Schema.Boolean }),
										})
										.pipe(Effect.as(null))
								: decision
										.decide(
											Decision.make({
												input: Schema.String,
												decisions: {
													allowed: Decision.probability({
														instructions: "Is it allowed?",
													}),
												},
											}),
											{ input: "Read docs." },
										)
										.pipe(Effect.as(null))
						const failure = yield* models
							.run(fence, "judge", null, {
								codec: Schema.Null,
								send: () => send,
								usage: () =>
									assert.fail("A failed answer has no success result."),
								beforeSend: Effect.void,
							})
							.pipe(Effect.flip)
						assert.isTrue(Schema.is(Execution.Failure)(failure))
						assert.equal(yield* Ref.get(sends), 1)
						assert.equal(yield* Ref.get(writes), 3)
					}).pipe(Effect.provide(billing))
				}),
		)

	it.effect(
		"a saved rule answer repairs usage and keeps every model input in its key",
		() =>
			Effect.gen(function* () {
				const fence = yield* start("saved-rule-answer")
				const store = yield* Store.Store
				const sends = yield* Ref.make(0)
				const recorded = yield* Ref.make(0)
				const model = yield* DecisionModel.make({
					decide: () =>
						Effect.gen(function* () {
							yield* Ref.update(sends, (n) => n + 1)
							const identity = yield* CurrentCallIdentity
							assert.equal(identity?.executionId, fence.id)
							assert.equal((yield* yield* CurrentAttribution).source, "judge")
							return {
								answers: {
									decision: {
										_tag: "Classify" as const,
										label: "allow",
										probabilities: { allow: 1, deny: 0, no_match: 0 },
									},
									rule_0: { _tag: "Probability" as const, probability: 1 },
								},
								usage: { inputTokens: 10, outputTokens: 5 },
							}
						}),
				})
				const input: Judge.Input = {
					organizationId: "org",
					bot: BotFixture.bot,
					capability: { action: "tools.call", target: "read_docs" },
					reason: "Read the docs.",
					rules: [
						{
							id: BotDomain.RuleId.make("rule"),
							bot: BotFixture.bot.id,
							author: { _tag: "Person", userId: "user" },
							text: "The Bot may call read_docs.",
							status: "active",
							version: 1,
							createdAt: 0,
							updatedAt: 0,
						},
					],
				}
				const registry = Layer.mock(ModelRegistry, {
					defaultModel: Option.none(),
					helperSelection: () => Effect.succeed(selection),
					resolveAny: () => Effect.succeed(AnyModel.Decision({ model })),
				})
				const billing = Layer.mock(Billing, {
					unknown: () => Effect.void,
					record: () =>
						Ref.updateAndGet(recorded, (n) => n + 1).pipe(
							Effect.flatMap((count) =>
								count === 1
									? Effect.fail(
											BillingStorageError.make({
												cause: "The usage write failed.",
												retryable: true,
											}),
										)
									: Effect.void,
							),
						),
				})
				yield* Effect.gen(function* () {
					const judge = yield* Judge.Judge
					assert.equal((yield* judge.decide(input)).decision, "allow")
					assert.equal(yield* Ref.get(recorded), 2)
					assert.equal((yield* judge.decide(input)).decision, "allow")
					assert.equal(yield* Ref.get(sends), 1)
					assert.equal((yield* store.calls(fence)).length, 1)
					for (const changed of [
						{ ...input, reason: "Read other docs." },
						{ ...input, bot: { ...input.bot, role: "Reads all docs." } },
						{
							...input,
							rules: Arr.map(input.rules, (rule) => ({ ...rule, version: 2 })),
						},
					])
						assert.equal((yield* judge.decide(changed)).decision, "allow")
					assert.equal(yield* Ref.get(sends), 4)
					const allowed = yield* Allowed
					yield* Ref.set(allowed, false)
					assert.equal((yield* judge.decide(input)).decision, "no_match")
					yield* Ref.set(allowed, true)
					assert.equal(yield* Ref.get(sends), 4)
				}).pipe(
					Effect.provide(
						Judge.durableLayer(fence).pipe(
							Layer.provide([registry, billing, judgeAccess]),
						),
					),
				)
			}),
	)

	it.effect(
		"a rule model lost before its result uses a new attempt after takeover",
		() =>
			Effect.gen(function* () {
				const first = yield* start("rule-model-takeover")
				const store = yield* Store.Store
				const sends = yield* Ref.make(0)
				const model = yield* DecisionModel.make({
					decide: () =>
						Effect.gen(function* () {
							if ((yield* Ref.updateAndGet(sends, (n) => n + 1)) === 1)
								return yield* Effect.interrupt
							return {
								answers: {
									decision: {
										_tag: "Classify" as const,
										label: "allow",
										probabilities: { allow: 1, deny: 0, no_match: 0 },
									},
									rule_0: { _tag: "Probability" as const, probability: 1 },
								},
								usage: { inputTokens: 10, outputTokens: 5 },
							}
						}),
				})
				const input: Judge.Input = {
					organizationId: "org",
					bot: BotFixture.bot,
					capability: { action: "tools.call", target: "read_docs" },
					reason: "Read the docs.",
					rules: [
						{
							id: BotDomain.RuleId.make("rule"),
							bot: BotFixture.bot.id,
							author: { _tag: "Person", userId: "user" },
							text: "The Bot may call read_docs.",
							status: "active",
							version: 1,
							createdAt: 0,
							updatedAt: 0,
						},
					],
				}
				const decide = (fence: Store.Fence) =>
					Judge.Judge.use((judge) => judge.decide(input)).pipe(
						Effect.provide(
							Judge.durableLayer(fence).pipe(
								Layer.provide([
									judgeAccess,
									Layer.mock(ModelRegistry, {
										defaultModel: Option.none(),
										helperSelection: () => Effect.succeed(selection),
										resolveAny: () =>
											Effect.succeed(AnyModel.Decision({ model })),
									}),
									Layer.mock(Billing, {
										record: () => Effect.void,
										unknown: () =>
											Effect.die("The saved result has confirmed usage."),
									}),
								]),
							),
						),
					)
				assert.isTrue(Exit.hasInterrupts(yield* Effect.exit(decide(first))))
				const second = yield* store.takeOver(first)
				assert.equal((yield* decide(second)).decision, "allow")
				const history = yield* store.calls(first)
				assert.equal(history.length, 2)
				const lost = Arr.findFirst(history, (call) => call.attempt === 0)
				assert.ok(Option.isSome(lost))
				assert.equal(lost.value.status, "outcome_unknown")
			}),
	)

	for (const retry of ["idempotent", "local"] as const)
		for (const closed of [false, true])
			it.effect(
				`a ${retry} command tool recovers after owner loss with closed rights ${closed}`,
				() =>
					Effect.gen(function* () {
						const first = yield* start(`${retry}-command-tool-${closed}`)
						const store = yield* Store.Store
						const steps = yield* ToolSteps.ToolSteps
						const advance = yield* AdvanceAllowed
						yield* Effect.addFinalizer(() => Ref.set(advance, true))
						const position = {
							chat: Chat.Id.make("chat"),
							turn: Turn.Id.make("turn"),
							item: Item.Id.make("item"),
							step: 0,
						}
						const call = Prompt.makePart("tool-call", {
							id: "command",
							providerExecuted: false,
							name: "command",
							params: {},
						})
						const writes = yield* Ref.make(0)
						const sends = yield* Ref.make(0)
						const toolkit = Toolkit.make(
							Tool.make("command", {
								parameters: Schema.Struct({}),
								success: Schema.Json,
							})
								.annotate(retry === "local" ? Local : Idempotent, true)
								.annotate(
									SavedResult,
									closed
										? (id) =>
												store
													.receipt(
														first.namespace,
														Execution.CommandKey.make(`internal-command:${id}`),
														{ actor, body: { work: "save" } },
													)
													.pipe(
														Effect.map(
															Option.map((receipt) => ({
																sequence: receipt.sequence,
															})),
														),
														Effect.orDie,
													)
										: undefined,
								)
								.addDependency(CallContext),
						)
						const handlers = toolkit.toLayer({
							command: () =>
								Effect.gen(function* () {
									const invocation = yield* CallContext
									assert.equal(
										invocation.fence.generation,
										(yield* store.load(first)).generation,
									)
									const receipt = yield* store.accept(
										invocation.fence.namespace,
										Execution.CommandKey.make(
											`internal-command:${invocation.id}`,
										),
										{ actor, body: { work: "save" } },
										() =>
											Ref.update(writes, (n) => n + 1).pipe(
												Effect.as({ executionId: first.id, start: false }),
											),
									)
									if ((yield* Ref.updateAndGet(sends, (n) => n + 1)) === 1)
										return yield* Effect.andThen(
											closed ? Ref.set(advance, false) : Effect.void,
											Effect.interrupt,
										)
									return { sequence: receipt.sequence }
								}).pipe(Effect.orDie),
						})
						const run = (fence: Store.Fence) =>
							Effect.gen(function* () {
								const built = yield* toolkit
								return yield* steps.run(
									fence,
									position,
									{ call, toolkit: built },
									() => Effect.void,
								)
							}).pipe(Effect.provide(handlers))
						assert.isTrue(Exit.hasInterrupts(yield* Effect.exit(run(first))))
						const sent = (yield* store.calls(first))[0]!
						assert.equal(sent.retry, retry)
						assert.equal(sent.status, "sending")
						const next = yield* store.takeOver(first)
						const result = yield* run(next)
						assert.deepEqual(yield* run(next), result)
						assert.equal(yield* Ref.get(writes), 1)
						assert.equal(yield* Ref.get(sends), closed ? 1 : 2)
						if (closed) {
							const built = yield* toolkit.pipe(Effect.provide(handlers))
							const denied = yield* steps
								.run(
									next,
									{ ...position, item: Item.Id.make("other-item") },
									{ call, toolkit: built },
									() => Effect.void,
								)
								.pipe(Effect.flip)
							assert.isTrue(Schema.is(Execution.Forbidden)(denied))
						}
						const calls = yield* store.calls(next)
						assert.equal(calls.length, closed ? 2 : 1)
						assert.isTrue(
							Arr.some(
								calls,
								(call) => call.id === sent.id && call.status === "completed",
							),
						)
						assert.equal((yield* store.get(next)).status, "running")
					}),
			)

	it.effect(
		"a saved decision can replay after it closes the right to act",
		() =>
			Effect.gen(function* () {
				const calls = yield* Calls.Calls
				const store = yield* Store.Store
				const advance = yield* AdvanceAllowed
				const first = yield* start("closed-decision-replay")
				const sent = yield* Ref.make(0)
				const send = Ref.update(sent, (n) => n + 1).pipe(
					Effect.andThen(Ref.set(advance, false)),
					Effect.as({ decided: true }),
				)
				const result = yield* calls.invoke(first, input, () => send)
				// The result reached storage, but the owner died before its Chat checkpoint.
				const second = yield* store.takeOver(first)
				assert.deepEqual(yield* calls.invoke(second, input, () => send), result)
				assert.equal(yield* Ref.get(sent), 1)
				const error = yield* calls
					.invoke(second, { ...input, step: "another-write" }, () => send)
					.pipe(Effect.flip)
				assert.ok(Schema.is(Execution.Forbidden)(error))
				assert.equal(yield* Ref.get(sent), 1)
			}).pipe(
				Effect.ensuring(
					Effect.flatMap(AdvanceAllowed, (ref) => Ref.set(ref, true)),
				),
			),
	)
	for (const answer of ["retry", "stop"] as const)
		it.effect(
			`an unknown write waits for ${answer} and keeps its first attempt`,
			() =>
				Effect.gen(function* () {
					const calls = yield* Calls.Calls
					const store = yield* Store.Store
					const fence = yield* start("unknown-decision-" + answer)
					const sent = yield* Ref.make(0)
					const first = yield* store.writeAttempt(
						fence,
						input.step,
						input.input,
					)
					const unknown = yield* calls.invoke(fence, first, () =>
						Ref.update(sent, (n) => n + 1).pipe(
							Effect.andThen(Effect.fail("lost reply")),
						),
					)
					assert.equal(unknown._tag, "Unknown")
					const pending = yield* calls.recover(fence, first.id)
					assert.deepEqual(pending, {
						_tag: "Pending",
						decisionId: first.id,
						afterSequence: (yield* store.get(fence)).sequence,
					})
					assert.equal((yield* store.get(fence)).status, "outcome_unknown")
					assert.equal(
						(yield* store.writeAttempt(fence, input.step, input.input)).id,
						first.id,
					)
					yield* store.retryCall(fence, first.id).pipe(
						Effect.flip,
						Effect.tap((error) =>
							Effect.sync(() =>
								assert.ok(Schema.is(Execution.Conflict)(error)),
							),
						),
					)
					yield* store.decide(
						fence,
						Execution.CommandKey.make("answer"),
						first.id,
						answer,
						actor,
					)
					const results = yield* Effect.all(
						[calls.recover(fence, first.id), calls.recover(fence, first.id)],
						{ concurrency: "unbounded" },
					)
					assert.deepEqual(results, [
						{ _tag: answer === "retry" ? "Retry" : "Stop" },
						{ _tag: answer === "retry" ? "Retry" : "Stop" },
					])
					const latest = yield* store.writeAttempt(
						fence,
						input.step,
						input.input,
					)
					if (answer === "retry") {
						assert.equal(latest.attempt, 1)
						assert.notEqual(latest.id, first.id)
						yield* calls.invoke(fence, latest, () =>
							Ref.update(sent, (n) => n + 1).pipe(Effect.as("done")),
						)
						assert.equal(yield* Ref.get(sent), 2)
						const events = yield* store.events(fence, 0)
						assert.equal(
							Arr.filter(
								events,
								(event) =>
									event.body._tag === "StepStarted" && event.body.attempt === 1,
							).length,
							1,
						)
					} else {
						assert.equal(latest.id, first.id)
						assert.equal(yield* Ref.get(sent), 1)
					}
					const history = yield* store.calls(fence)
					assert.equal(history[0]?.status, "outcome_unknown")
				}),
		)
	for (const revoked of ["actor", "decision maker"] as const)
		it.effect(`a send wait checks the ${revoked} again before sending`, () =>
			Effect.gen(function* () {
				const store = yield* Store.Store
				const calls = yield* Calls.Calls
				const fence = yield* start(`send-wait-${revoked}`)
				const allowed = yield* revoked === "actor"
					? AdvanceAllowed
					: DecisionAllowed
				let call = yield* store.writeAttempt(fence, input.step, input.input)
				if (revoked === "decision maker") {
					yield* store.sending(fence, call.id)
					yield* store.uncertain(fence, call.id)
					yield* store.decide(
						fence,
						Execution.CommandKey.make("retry"),
						call.id,
						"retry",
						actor,
					)
					call = yield* store.retryCall(fence, call.id)
				}
				const waiting = yield* Deferred.make<void>()
				const proceed = yield* Deferred.make<void>()
				const sent = yield* Ref.make(0)
				const result = yield* Effect.gen(function* () {
					const running = yield* calls
						.invoke(
							fence,
							call,
							() =>
								Ref.update(sent, (count) => count + 1).pipe(Effect.as("sent")),
							Deferred.succeed(waiting, undefined).pipe(
								Effect.andThen(Deferred.await(proceed)),
							),
						)
						.pipe(Effect.exit, Effect.forkScoped)
					yield* Deferred.await(waiting)
					yield* Ref.set(allowed, false)
					yield* Deferred.succeed(proceed, undefined)
					return yield* Fiber.join(running)
				}).pipe(Effect.ensuring(Ref.set(allowed, true)))
				assert.isTrue(Exit.isFailure(result))
				if (Exit.isFailure(result))
					assert.ok(
						Arr.some(
							result.cause.reasons,
							(reason) =>
								reason._tag === "Fail" &&
								Schema.is(Execution.Forbidden)(reason.error),
						),
					)
				assert.equal(yield* Ref.get(sent), 0)
				const saved = Arr.findFirst(
					yield* store.calls(fence),
					(saved) => saved.id === call.id,
				)
				assert.equal(Option.getOrThrow(saved).status, "intended")
			}),
		)

	for (const at of ["send", "result"] as const)
		for (const close of ["clean", "failed"] as const)
			it.effect(
				`cancel before the ${at} commit waits for ${close} resource release`,
				() =>
					Effect.gen(function* () {
						const store = yield* Store.Store
						const calls = yield* Calls.Calls
						const fence = yield* start(`cancel-commit-${at}-${close}`)
						const sent = yield* Ref.make(0)
						const released = yield* Ref.make(false)
						const cancel = store
							.cancel(fence, Execution.CommandKey.make("cancel"), actor)
							.pipe(Effect.asVoid)
						const workflow = Engine.define(`test-cancel-commit-${at}-${close}`)
						const handler = workflow.toLayer(() =>
							Effect.gen(function* () {
								const scopes = yield* RunScope.RunScope
								const outcome = yield* scopes.run(
									fence,
									"call",
									Effect.gen(function* () {
										yield* Effect.acquireRelease(Effect.void, () =>
											Ref.set(released, true).pipe(
												Effect.andThen(
													close === "failed"
														? Effect.die("The resource did not close.")
														: Effect.void,
												),
											),
										)
										yield* calls.invoke(
											fence,
											input,
											() =>
												Ref.update(sent, (count) => count + 1).pipe(
													Effect.andThen(
														at === "result" ? cancel : Effect.void,
													),
													Effect.as("saved result"),
												),
											at === "send" ? cancel : Effect.void,
										)
									}),
								)
								assert.equal(
									outcome._tag,
									close === "failed" ? "Failed" : "Cancelled",
								)
							}).pipe(Effect.orDie),
						)
						// No dispatcher sends the cancel signal. The committed state must stop the phase.
						yield* workflow
							.execute(fence)
							.pipe(
								Effect.provide(
									handler.pipe(
										Layer.provide(RunScope.layer),
										Layer.provideMerge(WorkflowEngine.layerMemory),
									),
								),
							)
						const state = yield* store.load(fence)
						assert.equal(state.phaseFailed, close === "failed")
						assert.equal(state.record.failure === null, close === "clean")
						assert.isTrue(yield* Ref.get(released))
						assert.equal(yield* Ref.get(sent), at === "send" ? 0 : 1)
						assert.equal(
							(yield* store.calls(fence))[0]?.status,
							at === "send" ? "intended" : "completed",
						)
						assert.equal(
							yield* store.finishCancellation(fence, state.cancelEpoch),
							close === "failed" ? "interrupted" : "cancelled",
						)
					}),
			)

	it.effect("a cancelled phase keeps a mixed work failure", () =>
		Effect.gen(function* () {
			const store = yield* Store.Store
			const fence = yield* start("cancel-mixed-work")
			const workflow = Engine.define("test-cancel-mixed-work")
			const handler = workflow.toLayer(() =>
				Effect.gen(function* () {
					const scopes = yield* RunScope.RunScope
					const outcome = yield* scopes.run(
						fence,
						"work",
						Effect.gen(function* () {
							yield* store.cancel(
								fence,
								Execution.CommandKey.make("cancel"),
								actor,
							)
							return yield* Effect.failCause(
								Cause.combine(
									Cause.fail(Execution.Conflict.make({ id: fence.id })),
									Cause.fail("The call failed."),
								),
							)
						}),
					)
					assert.equal(outcome._tag, "Failed")
				}).pipe(Effect.orDie),
			)
			yield* workflow
				.execute(fence)
				.pipe(
					Effect.provide(
						handler.pipe(
							Layer.provide(RunScope.layer),
							Layer.provideMerge(WorkflowEngine.layerMemory),
						),
					),
				)
			const state = yield* store.load(fence)
			assert.isTrue(state.phaseFailed)
			assert.equal(state.record.failure?.category, "unavailable")
			assert.equal(
				yield* store.finishCancellation(fence, state.cancelEpoch),
				"interrupted",
			)
		}),
	)

	it.effect(
		"a late result before the send check needs only replay rights",
		() =>
			Effect.gen(function* () {
				const store = yield* Store.Store
				const fence = yield* start("late-before-admission")
				const call = yield* store.intent(fence, input)
				yield* store.sending(fence, call.id)
				const advance = yield* AdvanceAllowed
				yield* Ref.set(advance, false)
				const withLateResult = Store.Store.of({
					...store,
					intent: (...args) =>
						Effect.gen(function* () {
							const saved = yield* store.intent(...args)
							yield* store.finishCall(fence, saved.id, "late result")
							return saved
						}),
				})
				const result = yield* Effect.gen(function* () {
					const calls = yield* Calls.Calls
					return yield* calls.invoke(
						fence,
						input,
						() => Effect.die("A known call must not send"),
						Effect.die("A known call must not ask again"),
					)
				}).pipe(
					Effect.provide(
						Calls.layer.pipe(
							Layer.provide(Layer.succeed(Store.Store, withLateResult)),
							Layer.fresh,
						),
					),
					Effect.ensuring(Ref.set(advance, true)),
				)
				assert.deepEqual(result, {
					_tag: "Completed",
					callId: call.id,
					result: "late result",
				})
			}),
	)
	for (const end of ["resume", "cancel", "deadline", "close-failure"] as const)
		it.effect(`a paused send releases its phase before ${end}`, () =>
			Effect.gen(function* () {
				const store = yield* Store.Store
				const entries = yield* Registry
				const owner = yield* start(`pause-owner-${end}`)
				const child = yield* start(`pause-child-${end}`)
				const paused = yield* Ref.make(false)
				const opened = yield* Ref.make(0)
				const closed = yield* Ref.make(0)
				const sent = yield* Ref.make(0)
				const caught = yield* Ref.make(false)
				const released = yield* Deferred.make<void>()
				const admitted = Layer.succeed(
					Registry,
					Registry.of({
						...entries,
						get: (name) =>
							entries.get(name).pipe(
								Effect.map(
									Option.map((entry) => ({
										...entry,
										admit: (_: Store.Key, lock: boolean) =>
											Effect.gen(function* () {
												if (lock) yield* store.guard(owner)
												const state = yield* store.get(owner)
												if (yield* Ref.get(paused))
													return yield* Admission.Paused.make({
														...owner,
														afterSequence: state.sequence,
													})
											}),
									})),
								),
							),
					}),
				)
				const workflow = Engine.define(`test-paused-send-${end}`)
				const deadline =
					end === "deadline"
						? (yield* Clock.currentTimeMillis) + 1500
						: undefined
				const handler = workflow.toLayer(() =>
					Effect.gen(function* () {
						const scopes = yield* RunScope.RunScope
						const calls = yield* Calls.Calls
						const result = yield* scopes.run(
							child,
							"send",
							Effect.gen(function* () {
								yield* Effect.acquireRelease(
									Ref.update(opened, (n) => n + 1),
									() =>
										Effect.gen(function* () {
											const count = yield* Ref.updateAndGet(
												closed,
												(n) => n + 1,
											)
											if (count !== 1) return
											if (end === "resume") {
												// Resume before the event reader starts. The saved cursor must still wake it.
												yield* Ref.set(paused, false)
												yield* store.commit(
													owner,
													{
														events: [
															{
																_tag: "Checkpoint",
																resource: { kind: "Chat", id: "owner" },
																revision: 1,
															},
														],
													},
													Effect.void,
												)
											}
											yield* Deferred.succeed(released, undefined)
											if (end === "close-failure")
												return yield* Effect.die("The connection did not close")
										}).pipe(Effect.orDie),
								)
								yield* calls
									.invoke(
										child,
										input,
										() =>
											Ref.update(sent, (n) => n + 1).pipe(Effect.as("saved")),
										Effect.gen(function* () {
											if ((yield* Ref.get(opened)) === 1)
												yield* Ref.set(paused, true)
										}),
									)
									.pipe(Effect.catchCause(() => Ref.set(caught, true)))
							}),
							deadline === undefined ? undefined : { deadline },
						)
						assert.equal(
							result._tag,
							end === "resume"
								? "Done"
								: end === "cancel"
									? "Cancelled"
									: end === "deadline"
										? "Expired"
										: "Failed",
						)
					}).pipe(Effect.orDie),
				)
				const runtime = handler.pipe(
					Layer.provideMerge(
						Layer.mergeAll(
							RunScope.layer,
							Calls.layer.pipe(Layer.provide(admitted), Layer.fresh),
						),
					),
					Layer.provideMerge(WorkflowEngine.layerMemory),
				)
				yield* Effect.gen(function* () {
					const execution = yield* workflow
						.execute(child)
						.pipe(Effect.forkScoped)
					yield* Deferred.await(released)
					if (end === "cancel") {
						yield* store.cancel(
							child,
							Execution.CommandKey.make("cancel"),
							actor,
						)
						const signal = Engine.cancelSignal(
							(yield* store.load(child)).cancelEpoch,
						)
						yield* DurableDeferred.succeed(signal, {
							token: yield* DurableDeferred.tokenFromPayload(signal, {
								workflow,
								payload: child,
							}),
							value: undefined,
						})
					}
					yield* Fiber.join(execution)
				}).pipe(Effect.provide(runtime))
				assert.equal(yield* Ref.get(opened), end === "resume" ? 2 : 1)
				assert.equal(yield* Ref.get(closed), yield* Ref.get(opened))
				assert.equal(yield* Ref.get(sent), end === "resume" ? 1 : 0)
				assert.isFalse(yield* Ref.get(caught))
				assert.equal(
					(yield* store.calls(child))[0]?.status,
					end === "resume" ? "completed" : "intended",
				)
			}),
		)
	for (const retry of ["never", "idempotent"] as const)
		for (const savedRetry of retry === "never" ? [false, true] : [false])
			it.effect(
				`a failed phase stops an unknown ${retry} call with saved retry ${savedRetry}`,
				() =>
					Effect.gen(function* () {
						const store = yield* Store.Store
						const calls = yield* Calls.Calls
						const fence = yield* start(`failed-unknown-${retry}-${savedRetry}`)
						const call = yield* store.intent(fence, { ...input, retry })
						yield* store.sending(fence, call.id)
						yield* store.uncertain(fence, call.id)
						if (savedRetry)
							yield* store.decide(
								fence,
								Execution.CommandKey.make("retry"),
								Execution.callDecisionId(
									call.id,
									(yield* store.load(fence)).cancelEpoch,
								),
								"retry",
								actor,
							)
						const failure = yield* (yield* Records.Records).record(
							Cause.die("The connection did not close"),
							"unavailable",
							fence.id,
						)
						yield* store.failPhase(fence, failure)
						if (!savedRetry) {
							assert.deepEqual(
								Option.getOrThrow(yield* store.decision(fence, call.id))
									.choices,
								["stop"],
							)
							assert.equal(
								(yield* store
									.decide(
										fence,
										Execution.CommandKey.make("retry"),
										call.id,
										"retry",
										actor,
									)
									.pipe(Effect.flip))._tag,
								"ExecutionConflict",
							)
							assert.equal(
								(yield* calls.recover(fence, call.id))._tag,
								"Pending",
							)
							yield* store.decide(
								fence,
								Execution.CommandKey.make("stop"),
								Execution.callDecisionId(
									call.id,
									(yield* store.load(fence)).cancelEpoch,
								),
								"stop",
								actor,
							)
						}
						assert.equal((yield* calls.recover(fence, call.id))._tag, "Stop")
						assert.lengthOf(yield* store.calls(fence), 1)
						yield* store.finishCall(fence, call.id, "late result")
						assert.equal((yield* store.calls(fence))[0]?.result, "late result")
						yield* store.transition(fence, "interrupted")
						assert.deepEqual((yield* store.get(fence)).failure, failure)
					}),
			)
	it.effect("a phase retries storage without keeping a failure", () =>
		Effect.gen(function* () {
			const store = yield* Store.Store
			const fence = yield* start("phase-storage-retry")
			const attempts = yield* Ref.make(0)
			const closed = yield* Ref.make(0)
			const workflow = Engine.define("test-phase-storage-retry")
			const handler = workflow.toLayer(() =>
				Effect.gen(function* () {
					const scopes = yield* RunScope.RunScope
					const result = yield* scopes.run(
						fence,
						"read",
						Effect.gen(function* () {
							yield* Effect.acquireRelease(Effect.void, () =>
								Ref.update(closed, (n) => n + 1),
							)
							if ((yield* Ref.getAndUpdate(attempts, (n) => n + 1)) === 0)
								return yield* Execution.StorageError.make({
									cause: "The database is down",
								})
						}),
					)
					assert.equal(result._tag, "Done")
				}).pipe(Effect.orDie),
			)
			yield* workflow
				.execute(fence)
				.pipe(
					Effect.provide(
						handler.pipe(
							Layer.provide(RunScope.layer),
							Layer.provideMerge(WorkflowEngine.layerMemory),
						),
					),
				)
			assert.equal(yield* Ref.get(attempts), 2)
			assert.equal(yield* Ref.get(closed), 2)
			assert.isNull((yield* store.get(fence)).failure)
		}),
	)
	for (const end of ["cancel", "deadline", "decision", "done"] as const)
		it.effect(`a ${end} race keeps a resource close failure`, () =>
			Effect.gen(function* () {
				const store = yield* Store.Store
				const fence = yield* start(`close-error-${end}`)
				const call = yield* store.intent(fence, input)
				const opened = yield* Deferred.make<void>()
				const workflow = Engine.define(`test-close-error-${end}`)
				const deadline = (yield* Clock.currentTimeMillis) + 1000
				const handler = workflow.toLayer(() =>
					Effect.gen(function* () {
						const scopes = yield* RunScope.RunScope
						const result = yield* scopes.run(
							fence,
							"close",
							Effect.gen(function* () {
								yield* Effect.acquireRelease(Effect.void, () =>
									Effect.die("The connection did not close"),
								)
								yield* Deferred.succeed(opened, undefined)
								if (end !== "done") return yield* Effect.never
							}),
							end === "deadline"
								? { deadline }
								: end === "decision"
									? { decisionId: "choice" }
									: undefined,
						)
						assert.equal(result._tag, "Failed")
						const failure = (yield* store.get(fence)).failure
						assert.isNotNull(failure)
						const events = yield* store.events(fence, 0)
						assert.ok(
							Arr.some(
								events,
								({ body }) =>
									body._tag === "State" &&
									body.failure?.errorId === failure?.errorId,
							),
						)
					}).pipe(Effect.orDie),
				)
				yield* Effect.gen(function* () {
					const running = yield* workflow.execute(fence).pipe(Effect.forkScoped)
					yield* Deferred.await(opened)
					if (end === "cancel") {
						yield* store.cancel(
							fence,
							Execution.CommandKey.make("close-cancel"),
							actor,
						)
						const signal = Engine.cancelSignal(
							(yield* store.load(fence)).cancelEpoch,
						)
						yield* DurableDeferred.succeed(signal, {
							token: yield* DurableDeferred.tokenFromPayload(signal, {
								workflow,
								payload: fence,
							}),
							value: undefined,
						})
					}
					if (end === "decision") {
						const signal = Engine.signal("choice")
						yield* DurableDeferred.succeed(signal, {
							token: yield* DurableDeferred.tokenFromPayload(signal, {
								workflow,
								payload: fence,
							}),
							value: undefined,
						})
					}
					yield* Fiber.join(running)
				}).pipe(
					Effect.provide(
						handler.pipe(
							Layer.provide(RunScope.layer),
							Layer.provideMerge(WorkflowEngine.layerMemory),
						),
					),
				)
				const failure = (yield* store.get(fence)).failure
				const next = yield* store.takeOver(fence)
				assert.deepEqual((yield* store.get(next)).failure, failure)
				const sent = yield* store.sending(next, call.id).pipe(Effect.flip)
				assert.equal(sent._tag, "ExecutionConflict")
				if (end !== "cancel")
					yield* store.cancel(
						next,
						Execution.CommandKey.make("close-stop"),
						actor,
					)
				assert.equal(
					yield* store.finishCancellation(
						next,
						(yield* store.load(next)).cancelEpoch,
					),
					"interrupted",
				)
				assert.deepEqual((yield* store.get(next)).failure, failure)
			}),
		)
	for (const end of ["success", "failure"] as const)
		it.effect(`a new owner does not reuse an old scope ${end}`, () =>
			Effect.gen(function* () {
				const store = yield* Store.Store
				const calls = yield* Calls.Calls
				const first = yield* start(`scope-owner-${end}`)
				const sends = yield* Ref.make(0)
				const workflow = Engine.define(`test-scope-owner-${end}`)
				const handler = workflow.toLayer(() =>
					Effect.gen(function* () {
						const scopes = yield* RunScope.RunScope
						const sent = yield* Deferred.make<void>()
						const release = yield* Deferred.make<void>()
						const old = yield* scopes
							.run(
								first,
								"call",
								Effect.gen(function* () {
									yield* calls.invoke(first, input, () =>
										Ref.update(sends, (n) => n + 1).pipe(Effect.as("saved")),
									)
									yield* Deferred.succeed(sent, undefined)
									yield* Deferred.await(release)
									if (end === "failure")
										return yield* Execution.Conflict.make({ id: first.id })
								}),
							)
							.pipe(Effect.exit, Effect.forkScoped)
						yield* Deferred.await(sent)
						const next = yield* store.takeOver(first)
						yield* Deferred.succeed(release, undefined)
						const stale = yield* Fiber.join(old)
						assert.isTrue(Exit.isFailure(stale))
						const resumed = yield* Ref.make(false)
						const result = yield* scopes.run(
							next,
							"call",
							Effect.gen(function* () {
								yield* Ref.set(resumed, true)
								yield* calls.invoke(next, input, () =>
									Ref.update(sends, (n) => n + 1).pipe(Effect.as("wrong")),
								)
							}),
						)
						assert.equal(result._tag, "Done")
						assert.isTrue(yield* Ref.get(resumed))
						assert.equal(yield* Ref.get(sends), 1)
					}).pipe(Effect.orDie),
				)
				yield* workflow
					.execute(first)
					.pipe(
						Effect.provide(
							handler.pipe(
								Layer.provide(RunScope.layer),
								Layer.provideMerge(WorkflowEngine.layerMemory),
							),
						),
					)
			}),
		)
	for (const retry of ["read_only", "never"] as const)
		it.effect(
			`a known ${retry} result stays in memory while its commit is retried`,
			() =>
				Effect.gen(function* () {
					const store = yield* Store.Store
					const fence = yield* start(`commit-retry-${retry}`)
					const sent = yield* Ref.make(0)
					const writes = yield* Ref.make(0)
					const flaky = Store.Store.of({
						...store,
						finishCall: (...args) =>
							Effect.gen(function* () {
								if ((yield* Ref.getAndUpdate(writes, (n) => n + 1)) === 0)
									return yield* Execution.StorageError.make({
										cause: "Database is down",
									})
								return yield* store.finishCall(...args)
							}),
					})
					const result = yield* Effect.gen(function* () {
						const calls = yield* Calls.Calls
						return yield* calls.invoke(fence, { ...input, retry }, () =>
							Ref.update(sent, (n) => n + 1).pipe(Effect.as("known result")),
						)
					}).pipe(
						Effect.provide(
							Calls.layer.pipe(
								Layer.fresh,
								Layer.provide(Layer.succeed(Store.Store, flaky)),
							),
						),
					)
					assert.equal(result._tag, "Completed")
					assert.equal(yield* Ref.get(sent), 1)
					assert.equal(yield* Ref.get(writes), 2)
					assert.equal((yield* store.calls(fence))[0]?.result, "known result")
				}),
		)
	it.effect(
		"a pending cancel after a reply still saves the known result first",
		() =>
			Effect.gen(function* () {
				const calls = yield* Calls.Calls
				const store = yield* Store.Store
				const fence = yield* start("known-before-first-save")
				const running = yield* Effect.withFiber((fiber) =>
					calls.invoke(
						fence,
						{
							...input,
							resultEvents: () => {
								// Set the exact gap after the reply and before the first save.
								fiber.interruptUnsafe(fiber.id)
								return []
							},
						},
						() => Effect.succeed("known"),
					),
				).pipe(Effect.forkScoped)
				yield* Fiber.await(running)
				assert.equal((yield* store.calls(fence))[0]?.result, "known")
				assert.equal((yield* store.calls(fence))[0]?.status, "completed")
			}),
	)
	it.effect("a known result storage wait can stop without sending again", () =>
		Effect.gen(function* () {
			const store = yield* Store.Store
			const fence = yield* start("stop-known-result-wait")
			const saving = yield* Deferred.make<void>()
			const sent = yield* Ref.make(0)
			const flaky = Store.Store.of({
				...store,
				finishCall: () =>
					Deferred.succeed(saving, undefined).pipe(
						Effect.andThen(
							Effect.fail(
								Execution.StorageError.make({ cause: "Database is down" }),
							),
						),
					),
			})
			const running = yield* Effect.gen(function* () {
				const calls = yield* Calls.Calls
				return yield* calls.invoke(fence, input, () =>
					Ref.update(sent, (n) => n + 1).pipe(Effect.as("known")),
				)
			}).pipe(
				Effect.provide(
					Calls.layer.pipe(
						Layer.fresh,
						Layer.provide(Layer.succeed(Store.Store, flaky)),
					),
				),
				Effect.forkScoped,
			)
			yield* Deferred.await(saving)
			yield* Fiber.interrupt(running).pipe(Effect.timeout("2 seconds"))
			assert.equal(yield* Ref.get(sent), 1)
			const [call] = yield* store.calls(fence)
			assert.ok(call !== undefined)
			assert.equal(call.status, "sending")
			const next = yield* store.takeOver(fence)
			assert.equal(
				(yield* store.sending(next, call.id)).status,
				"outcome_unknown",
			)
		}),
	)
	for (const answer of ["stop", "retry"] as const)
		for (const revoked of ["caller", "decision maker"] as const)
			it.effect(
				`a saved ${answer} is consumed after the ${revoked} loses access`,
				() =>
					Effect.gen(function* () {
						const calls = yield* Calls.Calls
						const store = yield* Store.Store
						const access = yield* revoked === "caller"
							? Allowed
							: DecisionAllowed
						const first = yield* start(`saved-${answer}-${revoked}`)
						const call = yield* store.writeAttempt(
							first,
							input.step,
							input.input,
						)
						yield* store.sending(first, call.id)
						yield* store.uncertain(first, call.id)
						yield* calls.recover(first, call.id)
						yield* store.decide(
							first,
							Execution.CommandKey.make("answer"),
							call.id,
							answer,
							actor,
						)
						yield* Ref.set(access, false)
						const fence = yield* store.takeOver(first)
						const results = yield* Effect.all(
							[calls.recover(fence, call.id), calls.recover(fence, call.id)],
							{ concurrency: "unbounded" },
						)
						assert.deepEqual(results, [
							{ _tag: answer === "stop" ? "Stop" : "Retry" },
							{ _tag: answer === "stop" ? "Stop" : "Retry" },
						])
						const history = yield* store.calls(fence)
						assert.equal(history[0]?.status, "outcome_unknown")
						assert.equal(history.length, answer === "stop" ? 1 : 2)
						if (answer === "retry") {
							const retry = yield* store.writeAttempt(
								fence,
								input.step,
								input.input,
							)
							assert.equal(retry.attempt, 1)
							const sent = yield* Ref.make(0)
							const error = yield* calls
								.invoke(fence, retry, () =>
									Ref.update(sent, (n) => n + 1).pipe(Effect.as("done")),
								)
								.pipe(Effect.flip)
							assert.ok(Schema.is(Execution.Forbidden)(error))
							assert.equal(yield* Ref.get(sent), 0)
							assert.equal((yield* store.calls(fence))[1]?.status, "intended")
							yield* store.transition(fence, "interrupted")
							assert.equal((yield* store.get(fence)).status, "interrupted")
						}
					}).pipe(
						Effect.ensuring(
							Effect.gen(function* () {
								yield* Ref.set(yield* Allowed, true)
								yield* Ref.set(yield* DecisionAllowed, true)
							}),
						),
					),
			)
	it.effect("a retry saved before cancel cannot start a new attempt", () =>
		Effect.gen(function* () {
			const store = yield* Store.Store
			const calls = yield* Calls.Calls
			const fence = yield* start("retry-before-cancel")
			const call = yield* store.intent(fence, input)
			yield* store.sending(fence, call.id)
			yield* store.uncertain(fence, call.id)
			const receipt = yield* store.decide(
				fence,
				Execution.CommandKey.make("old-retry"),
				call.id,
				"retry",
				actor,
			)
			yield* store.cancel(fence, Execution.CommandKey.make("cancel"), actor)
			const epoch = (yield* store.load(fence)).cancelEpoch
			yield* store.finishCancellation(fence, epoch)
			const pending = yield* calls.recover(fence, call.id)
			assert.equal(pending._tag, "Pending")
			if (pending._tag !== "Pending") return
			assert.equal(pending.decisionId, Execution.callDecisionId(call.id, epoch))
			assert.notEqual(pending.decisionId, call.id)
			assert.lengthOf(yield* store.calls(fence), 1)
			assert.isTrue((yield* store.load(fence)).cancelPending)
			assert.deepEqual(
				yield* store.decide(
					fence,
					Execution.CommandKey.make("old-retry"),
					call.id,
					"retry",
					actor,
				),
				receipt,
			)
			assert.ok(
				Schema.is(Execution.Conflict)(
					yield* store
						.decide(
							fence,
							Execution.CommandKey.make("old-choice"),
							call.id,
							"retry",
							actor,
						)
						.pipe(Effect.flip),
				),
			)
			yield* store.decide(
				fence,
				Execution.CommandKey.make("new-retry"),
				pending.decisionId,
				"retry",
				actor,
			)
			assert.equal((yield* calls.recover(fence, call.id))._tag, "Retry")
			assert.isFalse((yield* store.load(fence)).cancelPending)
			const next = yield* store.writeAttempt(fence, input.step, input.input)
			assert.equal(next.attempt, 1)
			assert.equal(
				(yield* calls.invoke(fence, next, () => Effect.succeed("done")))._tag,
				"Completed",
			)
		}),
	)
	for (const other of ["result", "retry"] as const)
		it.effect(
			`a saved stop survives another call's ${other} and a new owner`,
			() =>
				Effect.gen(function* () {
					const store = yield* Store.Store
					const firstOwner = yield* start(`stop-many-${other}`)
					const first = yield* store.intent(firstOwner, input)
					const second = yield* store.intent(firstOwner, {
						...input,
						step: "second",
					})
					yield* store.sending(firstOwner, first.id)
					yield* store.sending(firstOwner, second.id)
					yield* store.uncertain(firstOwner, first.id)
					yield* store.uncertain(firstOwner, second.id)
					yield* store.decide(
						firstOwner,
						Execution.CommandKey.make("stop"),
						first.id,
						"stop",
						actor,
					)
					yield* store.finishCall(firstOwner, first.id, "first")
					if (other === "result")
						yield* store.finishCall(firstOwner, second.id, "second")
					else
						yield* store.decide(
							firstOwner,
							Execution.CommandKey.make("retry"),
							second.id,
							"retry",
							actor,
						)
					for (const round of [0, 1]) {
						const fence =
							round === 0 ? firstOwner : yield* store.takeOver(firstOwner)
						const workflow = Engine.define(`test-stop-many-${other}-${round}`)
						const handler = workflow.toLayer(() =>
							Effect.gen(function* () {
								const settle = yield* CallRecovery.make
								assert.isTrue((yield* settle(fence)).stop)
							}).pipe(Effect.orDie),
						)
						yield* workflow
							.execute(fence)
							.pipe(
								Effect.provide(
									handler.pipe(
										Layer.provide(RunScope.layer),
										Layer.provideMerge(WorkflowEngine.layerMemory),
									),
								),
							)
					}
					assert.isFalse(
						Arr.some(
							yield* store.calls(firstOwner),
							(call) => call.status === "sending",
						),
					)
				}),
		)
	it.effect(
		"common call recovery waits for a second unknown call after the first result",
		() =>
			Effect.gen(function* () {
				const store = yield* Store.Store
				const fence = yield* start("common-many-late")
				const first = yield* store.intent(fence, input)
				const second = yield* store.intent(fence, { ...input, step: "second" })
				yield* store.sending(fence, first.id)
				yield* store.sending(fence, second.id)
				yield* store.uncertain(fence, first.id)
				yield* store.uncertain(fence, second.id)
				yield* store.finishCall(fence, first.id, "first")
				const opened = yield* Deferred.make<void>()
				const workflow = Engine.define("test-common-many-late")
				const handler = workflow.toLayer(() =>
					Effect.gen(function* () {
						const settle = yield* CallRecovery.make
						yield* Deferred.succeed(opened, undefined)
						const result = yield* settle(fence)
						assert.deepEqual(result, { stop: false, restarted: true })
					}).pipe(Effect.orDie),
				)
				yield* Effect.gen(function* () {
					const run = yield* workflow.execute(fence).pipe(Effect.forkScoped)
					yield* Deferred.await(opened)
					yield* store.finishCall(fence, second.id, "second")
					yield* Fiber.join(run).pipe(Effect.timeout("5 seconds"))
				}).pipe(
					Effect.provide(
						handler.pipe(
							Layer.provide(RunScope.layer),
							Layer.provideMerge(WorkflowEngine.layerMemory),
						),
					),
				)
				assert.equal((yield* store.get(fence)).status, "running")
				assert.lengthOf(yield* store.calls(fence), 2)
			}),
	)

	for (const retry of ["never", "idempotent"] as const) {
		it.effect(
			`a late ${retry} result wakes the choice and needs no new send`,
			() =>
				Effect.gen(function* () {
					const store = yield* Store.Store
					const calls = yield* Calls.Calls
					const first = yield* start(`late-wake-${retry}`)
					const call = yield* store.intent(first, { ...input, retry })
					yield* store.sending(first, call.id)
					yield* store.uncertain(first, call.id)
					const fence = yield* store.takeOver(first)
					const pending = yield* calls.recover(fence, call.id)
					assert.equal(pending._tag, "Pending")
					if (pending._tag !== "Pending") return
					// The result arrives before observation starts. The saved cursor must catch it.
					assert.isFalse(
						yield* store.finishCall(first, call.id, { private: "result" }),
					)
					const recorded = yield* store.events(fence, pending.afterSequence)
					assert.deepEqual(
						Arr.map(recorded, (e) => e.body),
						[
							{
								_tag: "CallRecorded",
								callId: call.id,
								step: call.step,
								attempt: 0,
							},
						],
					)
					const sequence = (yield* store.get(fence)).sequence
					yield* store.finishCall(first, call.id, { private: "result" })
					assert.equal((yield* store.get(fence)).sequence, sequence)
					const workflow = Engine.define(`test-late-wake-${retry}`)
					const handler = workflow.toLayer(() =>
						Effect.gen(function* () {
							const scopes = yield* RunScope.RunScope
							const wake = yield* scopes.run(
								fence,
								"unknown",
								undefined,
								pending,
							)
							assert.equal(wake._tag, "Changed")
						}).pipe(Effect.orDie),
					)
					yield* workflow
						.execute(fence)
						.pipe(
							Effect.provide(
								handler.pipe(
									Layer.provide(RunScope.layer),
									Layer.provideMerge(WorkflowEngine.layerMemory),
								),
							),
						)
					for (const answer of retry === "never"
						? (["retry", "stop"] as const)
						: (["stop"] as const)) {
						const error = yield* store
							.decide(
								fence,
								Execution.CommandKey.make(answer),
								call.id,
								answer,
								actor,
							)
							.pipe(Effect.flip)
						assert.ok(Schema.is(Execution.Conflict)(error))
					}
					assert.equal((yield* calls.recover(fence, call.id))._tag, "Retry")
					assert.equal((yield* store.get(fence)).status, "running")
					const result = yield* calls.invoke(fence, { ...input, retry }, () =>
						Effect.die("Must not send"),
					)
					assert.deepEqual(result, {
						_tag: "Completed",
						callId: call.id,
						result: { private: "result" },
					})
					assert.lengthOf(yield* store.calls(fence), 1)
				}),
		)
		for (const failed of [false, true])
			it.effect(
				`a late ${retry} result keeps cancel with a failed phase ${failed}`,
				() =>
					Effect.gen(function* () {
						const store = yield* Store.Store
						const calls = yield* Calls.Calls
						const fence = yield* start(`late-cancel-${retry}-${failed}`)
						const call = yield* store.intent(fence, { ...input, retry })
						yield* store.sending(fence, call.id)
						if (failed) {
							const errors = yield* Records.Records
							yield* store.failPhase(
								fence,
								yield* errors.record(
									Cause.die("Close failed"),
									"unavailable",
									fence.id,
								),
							)
						}
						yield* store.cancel(
							fence,
							Execution.CommandKey.make("cancel"),
							actor,
						)
						const state = yield* store.load(fence)
						assert.equal(
							yield* store.finishCancellation(fence, state.cancelEpoch),
							"outcome_unknown",
						)
						assert.isTrue((yield* store.load(fence)).cancelPending)
						yield* store.finishCall(fence, call.id, "saved")
						assert.equal((yield* calls.recover(fence, call.id))._tag, "Retry")
						assert.equal((yield* store.get(fence)).status, "cancelling")
						assert.equal(
							yield* store.finishCancellation(fence, state.cancelEpoch),
							failed ? "interrupted" : "cancelled",
						)
						assert.lengthOf(yield* store.calls(fence), 1)
					}),
			)
	}
	for (const cancel of [false, true])
		it.effect(
			`late results wait for all current calls with cancel ${cancel}`,
			() =>
				Effect.gen(function* () {
					const store = yield* Store.Store
					const calls = yield* Calls.Calls
					const fence = yield* start(`late-many-${cancel}`)
					const first = yield* store.intent(fence, input)
					const second = yield* store.intent(fence, {
						...input,
						step: "second",
					})
					yield* store.sending(fence, first.id)
					yield* store.sending(fence, second.id)
					if (cancel) {
						yield* store.cancel(
							fence,
							Execution.CommandKey.make("cancel"),
							actor,
						)
						yield* store.finishCancellation(
							fence,
							(yield* store.load(fence)).cancelEpoch,
						)
					} else {
						yield* store.uncertain(fence, first.id)
						yield* store.uncertain(fence, second.id)
					}
					yield* store.finishCall(fence, first.id, "first")
					assert.equal((yield* calls.recover(fence, first.id))._tag, "Recorded")
					assert.equal((yield* store.get(fence)).status, "outcome_unknown")
					assert.equal((yield* calls.recover(fence, second.id))._tag, "Pending")
					yield* store.finishCall(fence, second.id, "second")
					assert.equal((yield* calls.recover(fence, second.id))._tag, "Retry")
					assert.equal(
						(yield* store.get(fence)).status,
						cancel ? "cancelling" : "running",
					)
				}),
		)
	it.effect(
		"a late result does not undo a saved stop or extend a terminal stream",
		() =>
			Effect.gen(function* () {
				const store = yield* Store.Store
				const calls = yield* Calls.Calls
				const fence = yield* start("late-stop")
				const call = yield* store.intent(fence, input)
				yield* store.sending(fence, call.id)
				yield* store.uncertain(fence, call.id)
				const receipt = yield* store.decide(
					fence,
					Execution.CommandKey.make("stop"),
					Execution.callDecisionId(
						call.id,
						(yield* store.load(fence)).cancelEpoch,
					),
					"stop",
					actor,
				)
				yield* store.finishCall(fence, call.id, "saved")
				assert.equal((yield* calls.recover(fence, call.id))._tag, "Stop")
				assert.deepEqual(
					yield* store.decide(
						fence,
						Execution.CommandKey.make("stop"),
						Execution.callDecisionId(
							call.id,
							(yield* store.load(fence)).cancelEpoch,
						),
						"stop",
						actor,
					),
					receipt,
				)
				yield* store.transition(fence, "interrupted")
				const sequence = (yield* store.get(fence)).sequence
				yield* store.finishCall(fence, call.id, "saved")
				assert.equal((yield* store.get(fence)).sequence, sequence)
			}),
	)

	it.effect("a late result before the retry avoids a second write", () =>
		Effect.gen(function* () {
			const calls = yield* Calls.Calls
			const store = yield* Store.Store
			const fence = yield* start("unknown-late-before-retry")
			const first = yield* store.writeAttempt(fence, input.step, input.input)
			yield* store.sending(fence, first.id)
			yield* store.uncertain(fence, first.id)
			yield* calls.recover(fence, first.id)
			yield* store.decide(
				fence,
				Execution.CommandKey.make("retry"),
				Execution.callDecisionId(
					first.id,
					(yield* store.load(fence)).cancelEpoch,
				),
				"retry",
				actor,
			)
			yield* store.finishCall(fence, first.id, "known")
			yield* calls.recover(fence, first.id)
			const latest = yield* store.writeAttempt(fence, input.step, input.input)
			assert.equal(latest.id, first.id)
			const result = yield* calls.invoke(fence, latest, () =>
				Effect.die("The saved result must be used"),
			)
			assert.deepEqual(result, {
				_tag: "Completed",
				callId: first.id,
				result: "known",
			})
		}),
	)
	it.effect(
		"a retry saved before a restart checks the decision maker again before sending",
		() =>
			Effect.gen(function* () {
				const calls = yield* Calls.Calls
				const store = yield* Store.Store
				const allowed = yield* DecisionAllowed
				const first = yield* start("retry-decision-revoked")
				const call = yield* store.writeAttempt(first, input.step, input.input)
				yield* store.sending(first, call.id)
				yield* store.uncertain(first, call.id)
				yield* calls.recover(first, call.id)
				yield* store.decide(
					first,
					Execution.CommandKey.make("retry"),
					Execution.callDecisionId(
						call.id,
						(yield* store.load(first)).cancelEpoch,
					),
					"retry",
					actor,
				)
				yield* calls.recover(first, call.id)
				// Even in the same generation, a late result must not advance an older attempt.
				assert.isFalse(yield* store.finishCall(first, call.id, "late"))
				const second = yield* store.takeOver(first)
				yield* Ref.set(allowed, false)
				const retry = yield* store.writeAttempt(second, input.step, input.input)
				const failure = yield* calls
					.invoke(second, retry, () => Effect.die("Must not send"))
					.pipe(Effect.flip)
				assert.ok(Schema.is(Execution.Forbidden)(failure))
				assert.equal((yield* store.calls(second))[1]?.status, "intended")
			}).pipe(
				Effect.ensuring(
					Effect.flatMap(DecisionAllowed, (ref) => Ref.set(ref, true)),
				),
			),
	)
	for (const stop of ["takeover", "cancel"] as const)
		it.effect(
			`a tool owner stopped by ${stop} saves its result without publishing or continuing`,
			() =>
				Effect.gen(function* () {
					const tools = yield* ToolSteps.ToolSteps
					const store = yield* Store.Store
					const first = yield* start("tool-late-result-" + stop)
					const sent = yield* Ref.make(0)
					const started = yield* Deferred.make<void>()
					const release = yield* Deferred.make<void>()
					const toolkit = Toolkit.make(
						Tool.make("Write", {
							parameters: Schema.Struct({}),
							success: Schema.String,
						}),
					)
					const handlers = yield* toolkit.pipe(
						Effect.provide(
							toolkit.toLayer({
								Write: () =>
									Ref.update(sent, (n) => n + 1).pipe(
										Effect.andThen(Deferred.succeed(started, undefined)),
										Effect.andThen(Deferred.await(release)),
										Effect.as("saved"),
									),
							}),
						),
					)
					const position = {
						chat: Chat.Id.make("chat"),
						turn: Turn.Id.make("turn"),
						item: Item.Id.make("item"),
						step: 1,
					}
					const input = {
						toolkit: handlers,
						call: Prompt.toolCallPart({
							id: "call",
							name: "Write",
							params: {},
							providerExecuted: false,
						}),
					}
					const published = yield* Ref.make(0)
					const running = yield* tools
						.executor(first)
						.run(position, input)
						.pipe(
							Stream.tap(() => Ref.update(published, (n) => n + 1)),
							Stream.runDrain,
							Effect.flip,
							Effect.forkScoped,
						)
					yield* Deferred.await(started)
					const second =
						stop === "takeover" ? yield* store.takeOver(first) : first
					if (stop === "cancel")
						yield* store.cancel(
							first,
							Execution.CommandKey.make("cancel"),
							actor,
						)
					yield* Deferred.succeed(release, undefined)
					assert.isTrue(
						Schema.is(Execution.Conflict)(yield* Fiber.join(running)),
					)
					assert.strictEqual(yield* Ref.get(published), 0)
					assert.strictEqual(
						(yield* store.calls(second))[0]?.status,
						"completed",
					)
					assert.strictEqual(
						Arr.filter(
							yield* store.events(second, 0),
							(event) => event.body._tag === "ToolOutput",
						).length,
						0,
					)
					if (stop === "cancel") {
						assert.strictEqual((yield* store.get(first)).status, "cancelling")
						return
					}
					yield* tools
						.executor(second)
						.run(position, input)
						.pipe(Stream.runDrain)
					yield* tools
						.executor(second)
						.run(position, input)
						.pipe(Stream.runDrain)
					assert.strictEqual(yield* Ref.get(sent), 1)
					assert.strictEqual(
						Arr.filter(
							yield* store.events(second, 0),
							(event) => event.body._tag === "ToolOutput",
						).length,
						1,
					)
				}).pipe(Effect.scoped),
		)

	it.effect("a saved tool result can be empty", () =>
		Effect.gen(function* () {
			const tools = yield* ToolSteps.ToolSteps
			const store = yield* Store.Store
			const first = yield* start("tool-void-result")
			const sent = yield* Ref.make(0)
			const toolkit = Toolkit.make(
				Tool.make("Write", {
					parameters: Schema.Struct({}),
					success: Schema.Void,
				}),
			)
			const handlers = yield* toolkit.pipe(
				Effect.provide(
					toolkit.toLayer({ Write: () => Ref.update(sent, (n) => n + 1) }),
				),
			)
			const position = {
				chat: Chat.Id.make("chat"),
				turn: Turn.Id.make("turn"),
				item: Item.Id.make("item"),
				step: 1,
			}
			const input = {
				toolkit: handlers,
				call: Prompt.toolCallPart({
					id: "call",
					name: "Write",
					params: {},
					providerExecuted: false,
				}),
			}
			const original = yield* tools
				.executor(first)
				.run(position, input)
				.pipe(Stream.runCollect)
			const replay = yield* tools
				.executor(yield* store.takeOver(first))
				.run(position, input)
				.pipe(Stream.runCollect)
			assert.deepStrictEqual(replay, original)
			assert.strictEqual(yield* Ref.get(sent), 1)
		}),
	)

	it.effect(
		"a lost tool write waits and does not run twice after takeover",
		() =>
			Effect.gen(function* () {
				const calls = yield* ToolSteps.ToolSteps
				const store = yield* Store.Store
				const first = yield* start("tool-lost-write")
				const sent = yield* Ref.make(0)
				const started = yield* Deferred.make<void>()
				const toolkit = Toolkit.make(
					Tool.make("Write", {
						parameters: Schema.Struct({}),
						success: Schema.String,
					}),
				)
				const handlers = yield* toolkit.pipe(
					Effect.provide(
						toolkit.toLayer({
							Write: () =>
								Ref.update(sent, (n) => n + 1).pipe(
									Effect.andThen(Deferred.succeed(started, undefined)),
									Effect.andThen(Effect.never),
								),
						}),
					),
				)
				const position = {
					chat: Chat.Id.make("chat"),
					turn: Turn.Id.make("turn"),
					item: Item.Id.make("item"),
					step: 1,
				}
				const input = {
					toolkit: handlers,
					call: Prompt.toolCallPart({
						id: "call",
						name: "Write",
						params: {},
						providerExecuted: false,
					}),
				}
				const running = yield* calls
					.executor(first)
					.run(position, input)
					.pipe(Stream.runDrain, Effect.forkScoped)
				yield* Deferred.await(started)
				yield* Fiber.interrupt(running)
				const second = yield* store.takeOver(first)
				const error = yield* calls
					.saved(second, position, input.call)
					.pipe(Effect.flip)
				assert.isTrue(Schema.is(Execution.OutcomeUnknown)(error))
				assert.strictEqual(yield* Ref.get(sent), 1)
				assert.strictEqual((yield* store.get(second)).status, "outcome_unknown")
				assert.strictEqual(
					Arr.filter(
						yield* store.events(second, 0),
						(event) => event.body._tag === "ToolOutput",
					).length,
					0,
				)
			}).pipe(Effect.scoped),
	)

	it.effect(
		"a stopped read tool gets a new attempt and saved results still need permission",
		() =>
			Effect.gen(function* () {
				const calls = yield* ToolSteps.ToolSteps
				const store = yield* Store.Store
				const first = yield* start("tool-retry-read")
				const sent = yield* Ref.make(0)
				const started = yield* Deferred.make<void>()
				const toolkit = Toolkit.make(
					Tool.make("Read", {
						parameters: Schema.Struct({}),
						success: Schema.String,
					}).annotate(Tool.Readonly, true),
				)
				const handlers = yield* toolkit.pipe(
					Effect.provide(
						toolkit.toLayer({
							Read: (_, context) =>
								Effect.gen(function* () {
									const attempt = yield* Ref.updateAndGet(sent, (n) => n + 1)
									yield* context.preliminary("reading")
									if (attempt === 1) {
										yield* Deferred.succeed(started, undefined)
										return yield* Effect.never
									}
									return "saved text"
								}),
						}),
					),
				)
				const position = {
					chat: Chat.Id.make("chat"),
					turn: Turn.Id.make("turn"),
					item: Item.Id.make("item"),
					step: 1,
				}
				const input = {
					toolkit: handlers,
					call: Prompt.toolCallPart({
						id: "call",
						name: "Read",
						params: {},
						providerExecuted: false,
					}),
				}
				const published = yield* Deferred.make<void>()
				const running = yield* calls
					.executor(first)
					.run(position, input)
					.pipe(
						Stream.tap(() => Deferred.succeed(published, undefined)),
						Stream.runDrain,
						Effect.forkScoped,
					)
				yield* Deferred.await(started)
				yield* Deferred.await(published)
				yield* Fiber.interrupt(running)
				const read = Option.getOrThrow(Arr.head(yield* store.calls(first)))
				yield* store.incompleteRead(first, read.id)
				assert.isTrue(
					Option.isNone(yield* calls.saved(first, position, input.call)),
				)
				const second = yield* store.takeOver(first)
				assert.isTrue(
					Option.isNone(yield* calls.saved(second, position, input.call)),
				)
				const parts = yield* calls
					.executor(second)
					.run(position, input)
					.pipe(Stream.runCollect)
				assert.strictEqual(
					Arr.last(parts).pipe(Option.getOrThrow).type,
					"tool-result",
				)
				assert.strictEqual(yield* Ref.get(sent), 2)
				const events = Arr.flatMap(yield* store.events(second, 0), (event) =>
					event.body._tag === "ToolOutput" ? [event.body.attempt] : [],
				)
				assert.deepStrictEqual(events, [0, 1, 1])
				yield* calls.executor(second).run(position, input).pipe(Stream.runDrain)
				assert.strictEqual(yield* Ref.get(sent), 2)
				const allowed = yield* Allowed
				yield* Ref.set(allowed, false)
				const denied = yield* calls
					.executor(second)
					.run(position, input)
					.pipe(
						Stream.runDrain,
						Effect.flip,
						Effect.ensuring(Ref.set(allowed, true)),
					)
				assert.isTrue(Schema.is(Execution.Forbidden)(denied))
				assert.strictEqual(yield* Ref.get(sent), 2)
			}).pipe(Effect.scoped),
	)
	it.effect(
		"model results and text survive replay without a second provider call",
		() =>
			Effect.gen(function* () {
				const sent = yield* Ref.make(0)
				const model = yield* LanguageModel.make({
					generateText: () => Effect.die("The test uses a stream."),
					streamText: () =>
						Stream.fromEffect(Ref.update(sent, (n) => n + 1)).pipe(
							Stream.flatMap(() =>
								Stream.make(
									Response.makePart("text-start", { id: "text" }),
									Response.makePart("text-delta", {
										id: "text",
										delta: "saved text",
									}),
									Response.makePart("text-end", { id: "text" }),
									Response.makePart("tool-call", {
										id: "tool-1",
										name: "Write",
										params: { text: "saved text" },
										providerExecuted: false,
									}),
									Response.makePart("finish", {
										reason: "tool-calls",
										usage: Response.Usage.make({
											inputTokens: {
												total: 1,
												uncached: 1,
												cacheRead: undefined,
												cacheWrite: undefined,
											},
											outputTokens: { total: 1, text: 1, reasoning: undefined },
										}),
									}),
								),
							),
						),
				})
				yield* Effect.gen(function* () {
					const steps = yield* ModelSteps.ModelSteps
					const store = yield* Store.Store
					const fence = yield* start("saved-model")
					const input = {
						prompt: Prompt.make("Write a note"),
						toolkit: Toolkit.make(
							Tool.make("Write", {
								parameters: Schema.Struct({ text: Schema.String }),
								success: Schema.Void,
							}),
						),
					}
					const first = yield* steps.run(fence, "model-1", selection, input)
					const recovered = yield* store.takeOver(fence)
					assert.deepStrictEqual(
						yield* steps.run(recovered, "model-1", selection, {
							...input,
							toolkit: Toolkit.make(),
						}),
						first,
					)
					assert.strictEqual(yield* Ref.get(sent), 1)
					const events = Arr.map(
						yield* store.events(fence, 0),
						(event) => event.body,
					)
					assert.deepStrictEqual(
						Arr.filter(
							events,
							(e) =>
								e._tag === "Text" ||
								e._tag === "StepStarted" ||
								e._tag === "StepCompleted",
						),
						[
							{ _tag: "StepStarted", step: "model-1", attempt: 0 },
							{ _tag: "Text", step: "model-1", attempt: 0, text: "saved text" },
							{ _tag: "StepCompleted", step: "model-1", attempt: 0 },
						],
					)
					assert.strictEqual(first.result.calls[0]?.id, "tool-1")
					const before = yield* store.get(recovered)
					const allowed = yield* Allowed
					yield* Ref.set(allowed, false)
					const denied = yield* steps
						.run(recovered, "model-2", selection, input)
						.pipe(Effect.flip, Effect.ensuring(Ref.set(allowed, true)))
					assert.isTrue(Schema.is(Execution.Forbidden)(denied))
					assert.deepStrictEqual(yield* store.get(recovered), before)
					assert.strictEqual((yield* store.calls(recovered)).length, 1)
					assert.strictEqual(yield* Ref.get(sent), 1)
				}).pipe(
					Effect.provide(
						ModelSteps.layer.pipe(
							Layer.provide(Layer.succeed(LanguageModel.LanguageModel, model)),
						),
					),
				)
			}),
	)
	it.effect("a model retry keeps the tools from its first request", () =>
		Effect.gen(function* () {
			const sent = yield* Ref.make(0)
			const entered = yield* Deferred.make<void>()
			const model = yield* LanguageModel.make({
				generateText: () => Effect.die("The test uses a stream"),
				streamText: ({ tools }) =>
					Stream.unwrap(
						Effect.gen(function* () {
							assert.deepEqual(
								Arr.map(tools, (tool) => tool.name),
								["Write"],
							)
							const attempt = yield* Ref.updateAndGet(sent, (n) => n + 1)
							if (attempt === 1) {
								yield* Deferred.succeed(entered, undefined)
								return Stream.never
							}
							return Stream.make(
								Response.makePart("finish", {
									reason: "stop",
									usage: Response.Usage.make({
										inputTokens: {
											total: 1,
											uncached: 1,
											cacheRead: undefined,
											cacheWrite: undefined,
										},
										outputTokens: { total: 1, text: 1, reasoning: undefined },
									}),
								}),
							)
						}),
					),
			})
			yield* Effect.gen(function* () {
				const steps = yield* ModelSteps.ModelSteps
				const store = yield* Store.Store
				const fence = yield* start("model-tool-retry")
				const input = {
					prompt: Prompt.make("Write a note"),
					toolkit: Toolkit.make(
						Tool.make("Write", {
							parameters: Schema.Struct({ text: Schema.String }),
							success: Schema.Void,
						}),
					),
				}
				const first = yield* steps
					.run(fence, "model-1", selection, input)
					.pipe(Effect.forkScoped)
				yield* Deferred.await(entered)
				yield* Fiber.interrupt(first)
				const recovered = yield* store.takeOver(fence)
				const result = yield* steps.run(recovered, "model-1", selection, {
					...input,
					toolkit: Toolkit.make(),
				})
				assert.equal(result.attempt, 1)
				assert.equal(yield* Ref.get(sent), 2)
				const calls = yield* store.calls(recovered)
				assert.equal(calls.length, 2)
				assert.deepEqual(calls[0]!.input, calls[1]!.input)
			}).pipe(
				Effect.provide(
					ModelSteps.layer.pipe(
						Layer.provide(Layer.succeed(LanguageModel.LanguageModel, model)),
					),
				),
			)
		}).pipe(Effect.scoped),
	)

	it.effect(
		"a saved summary repairs usage after takeover without a second model call",
		() =>
			Effect.gen(function* () {
				const sent = yield* Ref.make(0)
				const writes = yield* Ref.make<ReadonlyArray<Execution.CallId>>([])
				const model = yield* LanguageModel.make({
					generateText: () =>
						Effect.die("The durable adapter uses model steps."),
					streamText: () =>
						Stream.unwrap(
							Effect.gen(function* () {
								yield* Ref.update(sent, (n) => n + 1)
								assert.equal(
									(yield* yield* CurrentAttribution).source,
									"compaction",
								)
								assert.ok((yield* CurrentCallIdentity)?.id)
								return Stream.make(
									Response.makePart("text-start", { id: "summary" }),
									Response.makePart("text-delta", {
										id: "summary",
										delta: "The saved summary.",
									}),
									Response.makePart("text-end", { id: "summary" }),
									Response.makePart("finish", {
										reason: "stop",
										usage: Response.Usage.make({
											inputTokens: {
												total: 3,
												uncached: 3,
												cacheRead: undefined,
												cacheWrite: undefined,
											},
											outputTokens: { total: 2, text: 2, reasoning: undefined },
										}),
									}),
								)
							}),
						),
				})
				yield* Effect.gen(function* () {
					const steps = yield* ModelSteps.ModelSteps
					const store = yield* Store.Store
					const first = yield* start("saved-summary")
					const selection = Config.Selection.make({
						provider: Provider.Id.make("provider"),
						model: Model.Id.make("model"),
					})
					const input = {
						prompt: Prompt.make([
							{ role: "system", content: "Keep the goal." },
							{ role: "user", content: "private earlier text" },
							{ role: "assistant", content: "An earlier answer." },
							{ role: "user", content: "A recent message." },
						]),
						targetTokens: 100,
						keepRecentMessages: 1,
					}
					yield* steps.summarize(first, selection, input)
					assert.equal((yield* store.calls(first))[0]?.status, "completed")
					const next = yield* store.takeOver(first)
					const window = yield* steps.summarize(next, selection, input)
					assert.equal(window.prompt.content.length, 3)
					assert.deepEqual(window.prompt.content[0], input.prompt.content[0])
					assert.deepEqual(window.prompt.content[2], input.prompt.content[3])
					assert.equal(yield* Ref.get(sent), 1)
					const recorded = yield* Ref.get(writes)
					assert.equal(recorded.length, 3)
					assert.equal(recorded[0], recorded[1])
					assert.equal(
						Arr.filter(
							yield* store.events(next, 0),
							(event) => event.body._tag === "Text",
						).length,
						0,
					)
					assert.equal((yield* store.calls(next)).length, 1)
					yield* steps.summarize(next, selection, {
						...input,
						targetTokens: 200,
					})
					assert.equal(yield* Ref.get(sent), 2)
					assert.equal((yield* store.calls(next)).length, 2)
				}).pipe(
					Effect.provide(
						ModelSteps.layer.pipe(
							Layer.provide(Layer.succeed(LanguageModel.LanguageModel, model)),
							Layer.provide(
								Layer.mock(Billing, {
									unknown: () =>
										Effect.die("This summary has confirmed usage."),
									record: (id) =>
										Ref.updateAndGet(writes, Arr.append(id)).pipe(
											Effect.flatMap((ids) =>
												ids.length === 1
													? Effect.fail(
															BillingStorageError.make({
																cause: "The usage write failed.",
																retryable: true,
															}),
														)
													: Effect.void,
											),
										),
								}),
							),
						),
					),
				)
			}),
	)

	it.effect(
		"summary work uses the selected summary model instead of the turn model",
		() =>
			Effect.gen(function* () {
				const sent = yield* Ref.make(0)
				const primary = yield* LanguageModel.make({
					generateText: () =>
						Effect.die("The turn model must not write the summary."),
					streamText: () =>
						Stream.die("The turn model must not write the summary."),
				})
				const summary = yield* LanguageModel.make({
					generateText: () => Effect.die("Saved summaries use model steps."),
					streamText: () =>
						Stream.fromEffectDrain(Ref.update(sent, (n) => n + 1)).pipe(
							Stream.concat(
								Stream.make(
									Response.makePart("text-start", { id: "summary" }),
									Response.makePart("text-delta", {
										id: "summary",
										delta: "Summary from the selected model.",
									}),
									Response.makePart("text-end", { id: "summary" }),
									Response.makePart("finish", {
										reason: "stop",
										usage: Response.Usage.make({
											inputTokens: {
												total: 1,
												uncached: 1,
												cacheRead: undefined,
												cacheWrite: undefined,
											},
											outputTokens: { total: 1, text: 1, reasoning: undefined },
										}),
									}),
								),
							),
						),
				})
				const fence = yield* start("selected-summary-model")
				const provider = Provider.Id.make("provider")
				const selection = Config.Selection.make({
					provider,
					model: Model.Id.make("reply"),
				})
				const checked = yield* Ref.make<ReadonlyArray<Config.Selection>>([])
				const adapters = yield* ModelSteps.makeExecutors(fence, selection).pipe(
					Effect.provideService(LanguageModel.LanguageModel, primary),
					Effect.provideService(TurnAccess, {
						...(yield* TurnAccess),
						model: (_, selected) => Ref.update(checked, Arr.append(selected)),
					}),
				)
				const summarySelection = Config.Selection.make({
					provider,
					model: Model.Id.make("summary"),
				})
				const store = yield* ChatStoreRepository.make({
					definition: yield* CoreStore.define({
						stores: {},
						schemaVersion: "chat/1",
					}),
					persistence: yield* MemoryPersistence.make,
				})
				const initial = yield* store.create({ settings: { model: selection } })
				yield* store.modifyEffect({
					chat: initial.chat.id,
					update: (view) =>
						Effect.succeed([
							undefined,
							Option.some({
								value: {
									...view.state,
									conversation: {
										...view.state.conversation,
										context: ContextWindow.fromPrompt([
											{ role: "user", content: "old goal" },
											{ role: "assistant", content: "old answer" },
											{ role: "user", content: "new question" },
										]),
									},
								},
							}),
						] as const),
				})
				const runner = yield* TurnRunner.make({
					store,
					...adapters,
					bot: {
						modelCatalog: Effect.succeed([
							Config.Model.make({
								provider,
								id: selection.model,
								name: "Reply",
								reasoningEfforts: [],
								serviceTiers: [],
								contextWindow: 100,
								compaction: Config.Compaction.NonNative({
									model: summarySelection,
									keepRecentMessages: 1,
								}),
							}),
						]),
						providers: [
							new Provider.Provider({
								id: provider,
								model: (selected) => {
									assert.deepEqual(selected, summarySelection)
									return Effect.succeed(
										Model.make({
											provider,
											model: selected.model,
											layer: Layer.succeed(
												LanguageModel.LanguageModel,
												summary,
											),
										}),
									)
								},
							}),
						],
						compaction: {
							count: () => Effect.succeed(10),
							compact: () => Effect.die("This test uses a summary."),
						},
					},
				}).pipe(Effect.provideService(LanguageModel.LanguageModel, primary))
				const compacted = yield* runner.compact({
					chat: initial.chat.id,
					targetTokens: 50,
					request: { instructions: Prompt.empty, toolkit: Toolkit.empty },
				})
				assert.equal(yield* Ref.get(sent), 1)
				assert.deepEqual(yield* Ref.get(checked), [summarySelection])
				assert.include(
					yield* Schema.encodeEffect(Schema.fromJsonString(Prompt.Prompt))(
						compacted.view.state.conversation.context.prompt,
					),
					"Summary from the selected model.",
				)
			}),
	)

	it.effect(
		"new model sends check permission while saved results stay replayable",
		() =>
			Effect.gen(function* () {
				const sent = yield* Ref.make(0)
				const allowed = yield* Ref.make(true)
				const checked = yield* Ref.make<ReadonlyArray<Config.Selection>>([])
				const model = yield* LanguageModel.make({
					generateText: () => Effect.die("The test uses a stream."),
					streamText: () =>
						Stream.fromEffectDrain(Ref.update(sent, (n) => n + 1)).pipe(
							Stream.concat(
								Stream.make(
									Response.makePart("finish", {
										reason: "stop",
										usage: Response.Usage.make({
											inputTokens: {
												total: 1,
												uncached: 1,
												cacheRead: 0,
												cacheWrite: 0,
											},
											outputTokens: { total: 1, text: 1, reasoning: 0 },
										}),
									}),
								),
							),
						),
				})
				yield* Effect.gen(function* () {
					const steps = yield* ModelSteps.ModelSteps
					const store = yield* Store.Store
					const first = yield* start("model-send-permission")
					const input = { prompt: Prompt.make("hello"), toolkit: Toolkit.empty }
					const saved = yield* steps.run(first, "first", selection, input)
					yield* Ref.set(allowed, false)
					const next = yield* store.takeOver(first)
					assert.deepEqual(
						yield* steps.run(next, "first", selection, input),
						saved,
					)
					const blocked = yield* steps
						.run(next, "second", selection, input)
						.pipe(Effect.flip)
					assert.ok(Schema.is(Execution.Forbidden)(blocked))
					assert.equal(yield* Ref.get(sent), 1)
					assert.deepEqual(yield* Ref.get(checked), [selection, selection])
					const pending = Arr.findFirst(
						yield* store.calls(next),
						(call) => call.step === "second",
					)
					assert.ok(Option.isSome(pending))
					assert.equal(pending.value.status, "intended")
					const summarySelection = Config.Selection.make({
						...selection,
						model: Model.Id.make("summary"),
					})
					const summaryError = yield* steps
						.summarize(next, summarySelection, {
							prompt: Prompt.make([
								{ role: "user", content: "An earlier note." },
								{ role: "assistant", content: "An earlier answer." },
								{ role: "user", content: "A new note." },
							]),
							targetTokens: 10,
							keepRecentMessages: 1,
						})
						.pipe(Effect.flip)
					assert.ok(
						Schema.is(ContextCompaction.ContextCompactionError)(summaryError),
					)
					assert.equal(yield* Ref.get(sent), 1)
					assert.deepEqual(
						Arr.last(yield* Ref.get(checked)),
						Option.some(summarySelection),
					)
					assert.ok(Schema.is(Execution.Failure)(summaryError.cause))
					assert.equal(summaryError.cause.category, "forbidden")
					// The same unsent attempt may run after access is restored.
					yield* Ref.set(allowed, true)
					yield* steps.run(next, "second", selection, input)
					assert.equal(yield* Ref.get(sent), 2)
				}).pipe(
					Effect.provide(
						ModelSteps.layer.pipe(
							Layer.provide(
								Layer.mergeAll(
									Layer.succeed(LanguageModel.LanguageModel, model),
									Layer.mock(TurnAccess, {
										admit: () => Effect.void,
										model: (_, selection) =>
											Effect.gen(function* () {
												yield* Ref.update(checked, Arr.append(selection))
												if (!(yield* Ref.get(allowed)))
													return yield* Execution.Forbidden.make({})
											}),
									}),
								),
							),
						),
					),
				)
			}),
	)

	it.effect("replay releases a saved model result with unknown usage", () =>
		Effect.gen(function* () {
			const sent = yield* Ref.make(0)
			const writes = yield* Ref.make(0)
			const model = yield* LanguageModel.make({
				generateText: () => Effect.die("The test uses a stream."),
				streamText: () =>
					Stream.fromEffect(Ref.update(sent, (n) => n + 1)).pipe(
						Stream.flatMap(() =>
							Stream.make(
								Response.makePart("finish", {
									reason: "stop",
									usage: Response.Usage.make({
										inputTokens: {
											total: undefined,
											uncached: undefined,
											cacheRead: undefined,
											cacheWrite: undefined,
										},
										outputTokens: {
											total: undefined,
											text: undefined,
											reasoning: undefined,
										},
									}),
								}),
							),
						),
					),
			})
			yield* Effect.gen(function* () {
				const steps = yield* ModelSteps.ModelSteps
				const store = yield* Store.Store
				const fence = yield* start("unknown-model")
				const input = {
					prompt: Prompt.make("Read this note"),
					toolkit: Toolkit.empty,
				}
				yield* steps.run(fence, "model", selection, input)
				yield* steps.run(
					yield* store.takeOver(fence),
					"model",
					selection,
					input,
				)
				assert.strictEqual(yield* Ref.get(sent), 1)
				assert.strictEqual(yield* Ref.get(writes), 3)
			}).pipe(
				Effect.provide(
					ModelSteps.layer.pipe(
						Layer.provide(Layer.succeed(LanguageModel.LanguageModel, model)),
						Layer.provide(
							Layer.mock(Billing, {
								record: () => Effect.die("Unknown usage must not be charged."),
								unknown: () =>
									Ref.updateAndGet(writes, (n) => n + 1).pipe(
										Effect.flatMap((n) =>
											n === 1
												? Effect.fail(
														BillingStorageError.make({
															cause: "The database is down.",
															retryable: true,
														}),
													)
												: Effect.void,
										),
									),
							}),
						),
					),
				),
			)
		}),
	)
	it.effect(
		"a failed read gets a new attempt without repeating the old one",
		() =>
			Effect.gen(function* () {
				const calls = yield* Calls.Calls
				const store = yield* Store.Store
				const fence = yield* start("retry-read")
				const first = yield* store.readAttempt(fence, "model", null)
				const sent = yield* Ref.make(0)
				const send = () =>
					Ref.update(sent, (n) => n + 1).pipe(
						Effect.andThen(Effect.fail("The model stream broke.")),
					)
				yield* calls.invoke(fence, first, send).pipe(Effect.flip)
				assert.strictEqual((yield* store.get(fence)).status, "running")
				assert.strictEqual(
					(yield* calls.invoke(fence, first, send))._tag,
					"Unknown",
				)
				assert.strictEqual(yield* Ref.get(sent), 1)
				const second = yield* store.readAttempt(fence, "model", null)
				assert.strictEqual(second.attempt, first.attempt + 1)
				assert.notStrictEqual(second.id, first.id)
				const before = (yield* store.get(fence)).sequence
				yield* store.finishCall(fence, first.id, "late answer")
				assert.strictEqual((yield* store.get(fence)).sequence, before + 1)
				assert.strictEqual(
					(yield* calls.invoke(fence, second, () => Effect.succeed("answer")))
						._tag,
					"Completed",
				)
			}),
	)
	it.effect(
		"a saved call result is reused and current permission still applies",
		() =>
			Effect.gen(function* () {
				const calls = yield* Calls.Calls
				const fence = yield* start("saved")
				const sent = yield* Ref.make(0)
				const send = () =>
					Ref.updateAndGet(sent, (n) => n + 1).pipe(
						Effect.as({ text: "private result" }),
					)
				const result = yield* calls.invoke(fence, input, send)
				assert.deepStrictEqual(yield* calls.invoke(fence, input, send), result)
				assert.strictEqual(yield* Ref.get(sent), 1)
				const allowed = yield* Allowed
				yield* Ref.set(allowed, false)
				const denied = yield* calls
					.invoke(fence, input, send)
					.pipe(Effect.flip, Effect.ensuring(Ref.set(allowed, true)))
				assert.strictEqual(
					"_tag" in denied ? denied._tag : "failure",
					"ExecutionForbidden",
				)
				assert.strictEqual(yield* Ref.get(sent), 1)
			}),
	)
	it.effect(
		"a stopped owner cannot send and a lost unsafe write is never repeated",
		() =>
			Effect.gen(function* () {
				const calls = yield* Calls.Calls
				const store = yield* Store.Store
				const old = yield* start("lost-write")
				const call = yield* store.intent(old, input)
				yield* store.sending(old, call.id)
				const fence = yield* store.takeOver(old)
				const sent = yield* Ref.make(0)
				const send = () => Ref.updateAndGet(sent, (n) => n + 1)
				assert.isTrue(
					Schema.is(Execution.Conflict)(
						yield* calls.invoke(old, input, send).pipe(Effect.flip),
					),
				)
				assert.strictEqual(
					(yield* calls.invoke(fence, input, send))._tag,
					"Unknown",
				)
				assert.strictEqual(yield* Ref.get(sent), 0)
				assert.strictEqual((yield* store.get(fence)).status, "outcome_unknown")
			}),
	)
	it.effect("a write with a lost reply waits for a decision", () =>
		Effect.gen(function* () {
			const calls = yield* Calls.Calls
			const store = yield* Store.Store
			const fence = yield* start("lost-reply")
			const result = yield* calls.invoke(fence, input, () =>
				Effect.fail("The reply was lost."),
			)
			assert.strictEqual(result._tag, "Unknown")
			assert.strictEqual((yield* store.get(fence)).status, "outcome_unknown")
		}),
	)
	it.effect("a retry with provider support uses the first call key", () =>
		Effect.gen(function* () {
			const calls = yield* Calls.Calls
			const store = yield* Store.Store
			const old = yield* start("retry-write")
			const supported = { ...input, retry: "idempotent" } as const
			const call = yield* store.intent(old, supported)
			yield* store.sending(old, call.id)
			const fence = yield* store.takeOver(old)
			const result = yield* calls.invoke(fence, supported, (key) => {
				assert.strictEqual(key, call.id)
				return Effect.succeed({ key })
			})
			assert.strictEqual(result._tag, "Completed")
		}),
	)
})
