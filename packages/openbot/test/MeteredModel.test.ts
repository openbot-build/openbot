import { Execution } from "@openbot-build/domain"
import { Live, LiveDriver } from "@openbot-build/core"
import { assert, it } from "@effect/vitest"
import {
	Array as Arr,
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Logger,
	PubSub,
	Ref,
	References,
	Stream,
	Schema,
} from "effect"
import {
	AiError,
	LanguageModel,
	Response,
	Decision,
	DecisionModel,
	Telemetry,
} from "effect/ai"
import type * as Report from "../src/errors/Report.ts"
import { decodeEvent } from "../src/providers/openai/OpenAiRealtime.ts"
import { snapshot } from "../src/errors/Snapshot.ts"
import { TestClock } from "effect/testing"
import {
	type Billing,
	BillingStorageError,
	SpendingBlocked,
	type Tokens,
} from "../src/billing/Billing.ts"
import {
	meter,
	meterDecision,
	CurrentCallIdentity,
	attribute,
} from "../src/billing/MeteredModel.ts"
import {
	type Scope,
	TokenThrottle,
	Unavailable as TokenRateUnavailable,
} from "../src/billing/TokenThrottle.ts"

const unexpectedReport: Report.Report = () =>
	Effect.die("No report is expected.")
const reference = {
	errorId: Execution.ErrorId.make("test-error"),
	category: "unavailable" as const,
}

const call = {
	organizationId: "org_1",
	providerId: "prov_1",
	providerOwner: "platform" as const,
	modelId: "model_1",
}
const usage = {
	inputTokens: { total: 10, uncached: 10, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 5, text: 5, reasoning: 0 },
}
const tokens: Tokens = {
	inputUncached: 10,
	inputCacheRead: 0,
	inputCacheWrite: 0,
	outputText: 5,
	outputReasoning: 0,
}

/** A model that answers each call at once with the same usage. */
const model = LanguageModel.make({
	generateText: () =>
		Effect.succeed([Response.makePart("finish", { reason: "stop", usage })]),
	streamText: () => Stream.empty,
})

/** A throttle with no limits. */
const unthrottled = TokenThrottle.of({
	scopes: () => Effect.succeed([]),
	take: () => Effect.void,
	charge: () => Effect.succeed(0),
})

/** One bucket of the organization, for the throttles that hold calls back. */
const scope: Scope = {
	identity: {
		organizationId: "org_1",
		kind: "organization",
		subjectId: "org_1",
	},
	rate: { tokensPerSecond: 1, burstTokens: 1 },
}

/** A Billing with only the two methods that a metered model uses. */
const billingOf = (
	methods: Pick<Billing["Service"], "reserve" | "record"> &
		Partial<Pick<Billing["Service"], "unknown">>,
): Billing["Service"] => ({ unknown: () => Effect.void, ...methods }) as never

interface Line {
	readonly message: unknown
	readonly cause: Cause.Cause<unknown>
	readonly annotations: Readonly<Record<string, unknown>>
}

/** Collects the Warn logs of the effects that use its layer. */
const collect = () => {
	let reports: ReadonlyArray<{
		readonly operation: string
		readonly cause: unknown
	}> = []
	const report: Report.Report = (operation, cause) =>
		Effect.sync(() => {
			reports = [
				...reports,
				{ operation, cause: Cause.isCause(cause) ? cause : Cause.fail(cause) },
			]
			return reference
		})
	let lines: ReadonlyArray<Line> = []
	const layer = Logger.layer([
		Logger.make((log) => {
			if (log.logLevel === "Warn")
				lines = [
					...lines,
					{
						message: log.message,
						cause: log.cause,
						annotations: log.fiber.getRef(References.CurrentLogAnnotations),
					},
				]
		}),
	])
	return { layer, report, reports: () => reports, lines: () => lines }
}

// The record takes real time while the stop comes, so this test needs the real clock.
it.live("a stop after the answer still records the usage of the call", () =>
	Effect.gen(function* () {
		const recording = yield* Deferred.make<void>()
		const recorded = yield* Ref.make<ReadonlyArray<Tokens>>([])
		const billing = billingOf({
			reserve: () =>
				Effect.succeed({
					id: Execution.CallId.make("usage_test"),
					startedAt: 0,
				}),
			record: (_id, tokens) =>
				Deferred.succeed(recording, undefined).pipe(
					Effect.andThen(Effect.sleep("100 millis")),
					Effect.andThen(Ref.update(recorded, Arr.append(tokens))),
				),
		})
		const metered = meter(yield* model, call, {
			report: unexpectedReport,
			billing,
			throttle: unthrottled,
		})
		const fiber = yield* metered
			.generateText({ prompt: "Write" })
			.pipe(Effect.forkChild)
		yield* Deferred.await(recording)
		// The stop comes while the usage is on its way to the database.
		yield* Fiber.interrupt(fiber)
		assert.deepStrictEqual(yield* Ref.get(recorded), [tokens])
		assert.ok(Exit.hasInterrupts(yield* Fiber.await(fiber)))
	}),
)

it.effect("a record that hangs saves its cause and usage for repair", () => {
	const logs = collect()
	return Effect.gen(function* () {
		const metered = meter(yield* model, call, {
			report: logs.report,
			billing: billingOf({
				reserve: () =>
					Effect.succeed({
						id: Execution.CallId.make("usage_test"),
						startedAt: 0,
					}),
				record: () => Effect.never,
			}),
			throttle: unthrottled,
		})
		const fiber = yield* metered
			.generateText({ prompt: "Write" })
			.pipe(Effect.forkChild({ startImmediately: true }))
		yield* TestClock.adjust("30 seconds")
		const response = yield* Fiber.join(fiber)
		assert.strictEqual(response.usage.outputTokens.total, 5)
		assert.deepStrictEqual(logs.lines(), [])
		const [saved] = logs.reports()
		assert.ok(saved !== undefined && Cause.isCause(saved.cause))
		assert.equal(saved.operation, "model.recordUsage")
		assert.ok(Cause.hasFails(saved.cause))
		const details = yield* saved.cause.pipe(
			snapshot,
			Schema.encodeEffect(Schema.fromJsonString(Schema.Json)),
		)
		assert.include(details, "usage_test")
		assert.include(details, "inputUncached")
		assert.include(details, "outputText")
	}).pipe(Effect.provide(logs.layer))
})

it.effect(
	"a failed budget check keeps its cause out of the public error and log",
	() => {
		const logs = collect()
		return Effect.gen(function* () {
			const metered = meter(yield* model, call, {
				report: logs.report,
				billing: billingOf({
					reserve: () =>
						Effect.fail(
							BillingStorageError.make({ cause: "The database is down." }),
						),
					record: () => Effect.void,
				}),
				throttle: unthrottled,
			})
			const error = yield* metered
				.generateText({ prompt: "Write" })
				.pipe(Effect.flip)
			assert.ok(AiError.isAiError(error))
			assert.ok(error.reason._tag === "UnknownError")
			assert.deepStrictEqual(logs.lines(), [])
			const [saved] = logs.reports()
			assert.ok(saved !== undefined && Cause.isCause(saved.cause))
			assert.equal(saved.operation, "model.reserve")
			assert.match(Cause.pretty(saved.cause), /The database is down/)
			assert.notInclude(String(error), "The database is down")
			assert.deepStrictEqual(error.reason.metadata, { openbot: reference })
		}).pipe(Effect.provide(logs.layer))
	},
)

it.effect(
	"a stop while a paced stream waits for room still records the usage of the call",
	() =>
		Effect.gen(function* () {
			const ended = yield* Deferred.make<void>()
			const waiting = yield* Deferred.make<void>()
			const recorded = yield* Ref.make<ReadonlyArray<Tokens>>([])
			const settled = yield* Ref.make<ReadonlyArray<number>>([])
			// The provider sends all of its answer at once, and so bills the call.
			const provider = LanguageModel.make({
				generateText: () => Effect.succeed([]),
				streamText: () =>
					Stream.concat(
						Stream.make(
							Response.makePart("text-start", { id: "answer" }),
							Response.makePart("text-delta", {
								id: "answer",
								delta: "A long answer",
							}),
							Response.makePart("text-end", { id: "answer" }),
							Response.makePart("finish", { reason: "stop", usage }),
						),
						Stream.fromEffectDrain(Deferred.succeed(ended, undefined)),
					),
			})
			const metered = meter(yield* provider, call, {
				report: unexpectedReport,
				billing: billingOf({
					reserve: () =>
						Effect.succeed({
							id: Execution.CallId.make("usage_test"),
							startedAt: 0,
						}),
					record: (_id, tokens) => Ref.update(recorded, Arr.append(tokens)),
				}),
				// The buckets never get room for the output, so the output waits for ever.
				throttle: TokenThrottle.of({
					scopes: () => Effect.succeed([scope]),
					take: () => Effect.void,
					charge: (_scopes, tokens) =>
						tokens === 4
							? Deferred.succeed(waiting, undefined).pipe(Effect.as(100_000))
							: Ref.update(settled, Arr.append(tokens)).pipe(Effect.as(0)),
				}),
			})
			const fiber = yield* metered
				.streamText({ prompt: "Write" })
				.pipe(Stream.runDrain, Effect.forkChild)
			yield* Deferred.await(ended)
			yield* Deferred.await(waiting)
			// The stop comes while the output of a finished call waits for room.
			yield* Fiber.interrupt(fiber)
			assert.deepStrictEqual(yield* Ref.get(recorded), [tokens])
			assert.deepStrictEqual(yield* Ref.get(settled), [9])
			assert.ok(Exit.hasInterrupts(yield* Fiber.await(fiber)))
		}),
)

it.effect(
	"a call that waits for its buckets checks the budgets when the wait ends",
	() =>
		Effect.gen(function* () {
			const room = yield* Deferred.make<void>()
			const spent = yield* Ref.make(false)
			const metered = meter(yield* model, call, {
				report: unexpectedReport,
				billing: billingOf({
					reserve: () =>
						Effect.flatMap(Ref.get(spent), (isSpent) =>
							isSpent
								? Effect.fail(
										SpendingBlocked.make({
											reason: "budget",
											budgetId: "budget_1",
											message: "The budget is spent.",
										}),
									)
								: Effect.succeed({
										id: Execution.CallId.make("usage_test"),
										startedAt: 0,
									}),
						),
					record: () => Effect.void,
				}),
				throttle: TokenThrottle.of({
					scopes: () => Effect.succeed([scope]),
					take: () => Deferred.await(room),
					charge: () => Effect.succeed(0),
				}),
			})
			const fiber = yield* metered
				.generateText({ prompt: "Write" })
				.pipe(Effect.flip, Effect.forkChild({ startImmediately: true }))
			// Other work spends the budget while the call waits for its buckets.
			yield* Ref.set(spent, true)
			yield* Deferred.succeed(room, undefined)
			const error = yield* Fiber.join(fiber)
			assert.ok(AiError.isAiError(error))
			assert.strictEqual(error.reason._tag, "QuotaExhaustedError")
		}),
)

it.effect(
	"an ended stream without usage stays unknown and releases its reservation",
	() =>
		Effect.gen(function* () {
			const released = yield* Ref.make(false)
			const recorded = yield* Ref.make(0)
			const provider = yield* LanguageModel.make({
				generateText: () => Effect.succeed([]),
				streamText: () =>
					Stream.make(
						Response.makePart("text-start", { id: "text" }),
						Response.makePart("text-delta", { id: "text", delta: "partial" }),
					),
			})
			const metered = meter(provider, call, {
				report: unexpectedReport,
				throttle: unthrottled,
				billing: billingOf({
					reserve: () =>
						Effect.succeed({
							id: Execution.CallId.make("unknown-stream"),
							startedAt: 0,
						}),
					record: () => Ref.update(recorded, (n) => n + 1),
					unknown: () => Ref.set(released, true),
				}),
			})
			yield* metered.streamText({ prompt: "Write" }).pipe(Stream.runDrain)
			assert.strictEqual(yield* Ref.get(recorded), 0)
			assert.isTrue(yield* Ref.get(released))
		}),
)

it.effect(
	"a stop after a reservation releases it without inventing usage",
	() =>
		Effect.gen(function* () {
			const sent = yield* Deferred.make<void>()
			const released = yield* Ref.make(false)
			const provider = yield* LanguageModel.make({
				generateText: () =>
					Deferred.succeed(sent, undefined).pipe(Effect.andThen(Effect.never)),
				streamText: () => Stream.empty,
			})
			const metered = meter(provider, call, {
				report: unexpectedReport,
				throttle: unthrottled,
				billing: billingOf({
					reserve: () =>
						Effect.succeed({
							id: Execution.CallId.make("stopped-call"),
							startedAt: 0,
						}),
					record: () => Effect.die("The provider gave no usage."),
					unknown: () => Ref.set(released, true),
				}),
			})
			const fiber = yield* metered
				.generateText({ prompt: "Write" })
				.pipe(Effect.forkChild)
			yield* Deferred.await(sent)
			yield* Fiber.interrupt(fiber)
			assert.isTrue(yield* Ref.get(released))
		}),
)

for (const known of [false, true]) {
	it.effect(
		`a Live answer keeps ${known ? "confirmed" : "unknown"} provider usage`,
		() =>
			Effect.gen(function* () {
				const released = yield* Ref.make(false)
				const recorded = yield* Ref.make<ReadonlyArray<Tokens>>([])
				const events = yield* PubSub.unbounded<Live.Event>()
				const done = yield* decodeEvent(
					yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
						type: "response.done",
						response: {
							status: "completed",
							usage: known
								? {
										input_tokens: 30,
										output_tokens: 20,
										input_token_details: { cached_tokens: 5 },
									}
								: undefined,
						},
					}),
					unexpectedReport,
				)
				const driver = yield* LiveDriver.make({
					events,
					send: (input) =>
						input._tag === "Respond"
							? PubSub.publishAll(events, done).pipe(Effect.asVoid)
							: Effect.void,
					base: {
						audio: {
							input: { encoding: "pcm16", sampleRate: 24000 },
							output: { encoding: "pcm16", sampleRate: 24000 },
						},
						turnDetection: "server",
					},
				})
				const metered = meter(driver.model, call, {
					report: unexpectedReport,
					throttle: unthrottled,
					billing: billingOf({
						reserve: () =>
							Effect.succeed({
								id: Execution.CallId.make("live-usage"),
								startedAt: 0,
							}),
						record: (_id, tokens) => Ref.update(recorded, Arr.append(tokens)),
						unknown: () => Ref.set(released, true),
					}),
				})
				yield* metered.generateText({ prompt: "Hi" })
				assert.isTrue(yield* Ref.get(released))
				assert.deepStrictEqual(
					yield* Ref.get(recorded),
					known
						? [
								{
									inputUncached: 25,
									inputCacheRead: 5,
									inputCacheWrite: 0,
									outputText: 20,
									outputReasoning: 0,
								},
							]
						: [],
				)
			}),
	)
}

const decisionDefinition = Decision.make({
	input: Schema.Struct({ text: Schema.String }),
	decisions: {
		allowed: Decision.probability({
			instructions: "The text asks to read a file.",
		}),
	},
})
for (const method of ["decide", "decideSettled"] as const)
	for (const counts of ["known", "unknown"] as const)
		it.effect(`a ${method} call keeps its identity and ${counts} usage`, () =>
			Effect.gen(function* () {
				const identity = {
					id: Execution.CallId.make("decision-call"),
					executionId: Execution.Id.make("decision-execution"),
					generation: 1,
				}
				const reserved = yield* Ref.make(false)
				const recorded = yield* Ref.make<ReadonlyArray<Tokens>>([])
				const released = yield* Ref.make<ReadonlyArray<Execution.CallId>>([])
				const model = yield* DecisionModel.make({
					decide: () =>
						Effect.gen(function* () {
							assert.isTrue(yield* Ref.get(reserved))
							return {
								answers: {
									allowed: { _tag: "Probability" as const, probability: 1 },
								},
								usage:
									counts === "known"
										? { inputTokens: 10, outputTokens: 5 }
										: { inputTokens: 10, outputTokens: undefined },
							}
						}),
				})
				const billing = billingOf({
					reserve: (_, attribution, estimate, callIdentity) =>
						Effect.gen(function* () {
							assert.deepStrictEqual(callIdentity, identity)
							assert.equal(attribution.source, "judge")
							assert.isAbove(estimate.inputUncached, 0)
							yield* Ref.set(reserved, true)
							return { id: identity.id, startedAt: 0 }
						}),
					record: (id, value) =>
						Effect.gen(function* () {
							assert.equal(id, identity.id)
							yield* Ref.update(recorded, Arr.append(value))
						}),
					unknown: (id) => Ref.update(released, Arr.append(id)),
				})
				const metered = meterDecision(model, call, {
					report: unexpectedReport,
					billing,
					throttle: unthrottled,
				})
				const action: Effect.Effect<unknown, AiError.AiError> = metered[method](
					decisionDefinition,
					{ input: { text: "Read a file." } },
				)
				yield* action.pipe(
					attribute({ source: "judge" }),
					Effect.provideService(CurrentCallIdentity, identity),
				)
				assert.deepStrictEqual(
					yield* Ref.get(recorded),
					counts === "known" ? [tokens] : [],
				)
				assert.isTrue(
					Arr.every(yield* Ref.get(released), (id) => id === identity.id),
				)
				assert.isAbove((yield* Ref.get(released)).length, 0)
			}),
		)

it.effect(
	"a stopped decision call releases its reservation with unknown usage",
	() =>
		Effect.gen(function* () {
			const sent = yield* Deferred.make<void>()
			const released = yield* Ref.make(false)
			const model = yield* DecisionModel.make({
				decide: () =>
					Deferred.succeed(sent, undefined).pipe(Effect.andThen(Effect.never)),
			})
			const billing = billingOf({
				reserve: () =>
					Effect.succeed({
						id: Execution.CallId.make("stopped-decision"),
						startedAt: 0,
					}),
				record: () => Effect.die("A stopped call has no confirmed usage."),
				unknown: () => Ref.set(released, true),
			})
			const metered = meterDecision(model, call, {
				report: unexpectedReport,
				billing,
				throttle: unthrottled,
			})
			const fiber = yield* metered
				.decide(decisionDefinition, { input: { text: "Read a file." } })
				.pipe(Effect.forkChild)
			yield* Deferred.await(sent)
			yield* Fiber.interrupt(fiber)
			assert.isTrue(yield* Ref.get(released))
		}),
)

for (const response of ["refused", "missing", "invalid"] as const)
	it.effect(`a ${response} decision still records confirmed usage`, () =>
		Effect.gen(function* () {
			const recorded = yield* Ref.make<ReadonlyArray<Tokens>>([])
			const model = yield* DecisionModel.make({
				decide: () =>
					Effect.succeed({
						answers:
							response === "missing"
								? {}
								: {
										allowed:
											response === "refused"
												? { _tag: "Refusal" as const }
												: { _tag: "Probability" as const, probability: 2 },
									},
						usage: { inputTokens: 10, outputTokens: 5 },
					}),
			})
			const billing = billingOf({
				reserve: () =>
					Effect.succeed({
						id: Execution.CallId.make("failed-answer"),
						startedAt: 0,
					}),
				record: (_, value) => Ref.update(recorded, Arr.append(value)),
			})
			const error = yield* meterDecision(model, call, {
				report: unexpectedReport,
				billing,
				throttle: unthrottled,
			})
				.decide(decisionDefinition, { input: { text: "Read a file." } })
				.pipe(Effect.flip)
			assert.equal(
				error.reason._tag,
				response === "refused" ? "ContentPolicyError" : "InvalidOutputError",
			)
			assert.deepStrictEqual(yield* Ref.get(recorded), [tokens])
		}),
	)

for (const text of ["not JSON", "{}", ""])
	it.effect(`bad structured output keeps its confirmed usage: ${text}`, () =>
		Effect.gen(function* () {
			const recorded = yield* Ref.make<ReadonlyArray<Tokens>>([])
			const model = yield* LanguageModel.make({
				generateText: () =>
					Effect.succeed([
						Response.makePart("text", { text }),
						Response.makePart("finish", { reason: "stop", usage }),
					]),
				streamText: () => Stream.empty,
			})
			const metered = meter(model, call, {
				report: unexpectedReport,
				billing: billingOf({
					reserve: () =>
						Effect.succeed({
							id: Execution.CallId.make("invalid-object"),
							startedAt: 0,
						}),
					record: (_, used) => Ref.update(recorded, Arr.append(used)),
				}),
				throttle: unthrottled,
			})
			const error = yield* metered
				.generateObject({
					prompt: "Give an answer.",
					schema: Schema.Struct({ answer: Schema.Boolean }),
				})
				.pipe(Effect.flip)
			assert.equal(error.reason._tag, "StructuredOutputError")
			assert.deepEqual(yield* Ref.get(recorded), [tokens])
		}),
	)

it.effect(
	"structured output keeps the current hook or the model build hook",
	() =>
		Effect.gen(function* () {
			// Span hooks are synchronous. These counters check which hook the provider called.
			let built = 0
			let current = 0
			const buildHook: Telemetry.SpanTransformer = () => {
				built += 1
			}
			const model = yield* LanguageModel.make({
				generateText: () =>
					Effect.succeed([
						Response.makePart("text", { text: "{}" }),
						Response.makePart("finish", { reason: "stop", usage }),
					]),
				streamText: () => Stream.empty,
			}).pipe(
				Effect.provideService(Telemetry.CurrentSpanTransformer, buildHook),
			)
			const metered = meter(model, call, {
				report: unexpectedReport,
				billing: billingOf({
					reserve: () =>
						Effect.succeed({
							id: Execution.CallId.make("hook-call"),
							startedAt: 0,
						}),
					record: () => Effect.void,
				}),
				throttle: unthrottled,
				spanTransformer: buildHook,
			})
			const request = metered.generateObject({
				prompt: "Answer.",
				schema: Schema.Struct({}),
			})
			yield* request
			assert.equal(built, 1)
			yield* request.pipe(
				Effect.provideService(Telemetry.CurrentSpanTransformer, () => {
					current += 1
				}),
			)
			assert.equal(current, 1)
			assert.equal(built, 1)
		}),
)

it.effect(
	"model admission takes an estimate and settles only the confirmed difference",
	() =>
		Effect.gen(function* () {
			const events = yield* Ref.make<ReadonlyArray<readonly [string, number]>>(
				[],
			)
			const append = (name: string, value: number) =>
				Ref.update(events, Arr.append([name, value] as const))
			const metered = meter(yield* model, call, {
				report: unexpectedReport,
				billing: billingOf({
					reserve: () =>
						append("reserve", 0).pipe(
							Effect.as({
								id: Execution.CallId.make("estimate"),
								startedAt: 0,
							}),
						),
					record: () => append("record", 15),
				}),
				throttle: TokenThrottle.of({
					scopes: () => Effect.succeed([scope]),
					take: (_scopes, tokens) => append("take", tokens),
					charge: (_scopes, tokens) =>
						append("charge", tokens).pipe(Effect.as(0)),
				}),
			})
			yield* metered.generateText({ prompt: "Write" })
			assert.deepEqual(yield* Ref.get(events), [
				["take", 1026],
				["reserve", 0],
				["record", 15],
				["charge", -1011],
			])
		}),
)

it.effect(
	"a shared rate failure stops admission and keeps its storage cause out of the model error",
	() =>
		Effect.gen(function* () {
			const calls = yield* Ref.make(0)
			const log = collect()
			const metered = meter(yield* model, call, {
				report: log.report,
				billing: billingOf({
					reserve: () =>
						Ref.update(calls, (count) => count + 1).pipe(
							Effect.as({
								id: Execution.CallId.make("blocked-rate"),
								startedAt: 0,
							}),
						),
					record: () => Effect.void,
				}),
				throttle: TokenThrottle.of({
					scopes: () => Effect.succeed([scope]),
					take: () =>
						TokenRateUnavailable.make({ cause: "private database value" }),
					charge: () => Effect.succeed(0),
				}),
			})
			const error = yield* metered
				.generateText({ prompt: "Write" })
				.pipe(Effect.flip, Effect.provide(log.layer))
			assert.ok(error.reason._tag === "UnknownError")
			assert.notInclude(String(error), "private database value")
			assert.equal(yield* Ref.get(calls), 0)
			assert.equal(log.lines().length, 0)
			assert.equal(log.reports().length, 1)
			assert.deepStrictEqual(error.reason.metadata, { openbot: reference })
		}),
)

for (const step of ["rate", "reserve"] as const) {
	it.effect(
		`a stopped ${step} check keeps its interrupt without an error report`,
		() =>
			Effect.gen(function* () {
				const metered = meter(yield* model, call, {
					report: unexpectedReport,
					billing: billingOf({
						reserve: () => Effect.interrupt,
						record: () => Effect.die("The call did not start."),
					}),
					throttle: {
						...unthrottled,
						scopes: () =>
							step === "rate" ? Effect.interrupt : Effect.succeed([]),
					},
				})
				const fiber = yield* metered
					.generateText({ prompt: "Write" })
					.pipe(Effect.forkChild)
				const result = yield* Fiber.await(fiber)
				assert.ok(Exit.isFailure(result))
				assert.ok(Cause.hasInterruptsOnly(result.cause))
			}),
	)
}
