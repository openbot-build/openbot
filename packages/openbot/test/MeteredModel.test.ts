import { assert, it } from "@effect/vitest"
import {
	Array as Arr,
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Logger,
	Ref,
	References,
	Stream,
} from "effect"
import { AiError, LanguageModel, Response } from "effect/ai"
import { TestClock } from "effect/testing"
import {
	type Billing,
	BillingStorageError,
	SpendingBlocked,
	type Tokens,
} from "../src/billing/Billing.ts"
import { meter } from "../src/billing/MeteredModel.ts"
import { type Scope, TokenThrottle } from "../src/billing/TokenThrottle.ts"

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
	charge: () => Effect.void,
})

/** One bucket of the organization, for the throttles that hold calls back. */
const scope: Scope = {
	key: "organization:org_1",
	rate: { tokensPerSecond: 1, burstTokens: 1 },
}

/** A Billing with only the two methods that a metered model uses. */
const billingOf = (
	methods: Pick<Billing["Service"], "check" | "record">,
): Billing["Service"] => methods as never

interface Line {
	readonly message: unknown
	readonly cause: Cause.Cause<unknown>
	readonly annotations: Readonly<Record<string, unknown>>
}

/** Collects the Warn logs of the effects that use its layer. */
const collect = () => {
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
	return { layer, lines: () => lines }
}

// The record takes real time while the stop comes, so this test needs the real clock.
it.live("a stop after the answer still records the usage of the call", () =>
	Effect.gen(function* () {
		const recording = yield* Deferred.make<void>()
		const recorded = yield* Ref.make<ReadonlyArray<Tokens>>([])
		const billing = billingOf({
			check: () => Effect.void,
			record: (_call, _attribution, tokens) =>
				Deferred.succeed(recording, undefined).pipe(
					Effect.andThen(Effect.sleep("100 millis")),
					Effect.andThen(Ref.update(recorded, Arr.append(tokens))),
				),
		})
		const metered = meter(yield* model, call, {
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

it.effect(
	"a record that hangs gives up after a time, and the log keeps the lost usage",
	() => {
		const logs = collect()
		return Effect.gen(function* () {
			const metered = meter(yield* model, call, {
				billing: billingOf({
					check: () => Effect.void,
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
			const [line, ...rest] = logs.lines()
			assert.deepStrictEqual(rest, [])
			assert.ok(line !== undefined)
			assert.deepStrictEqual(line.message, [
				"OpenBot could not record model usage",
			])
			assert.ok(Cause.hasFails(line.cause))
			assert.deepStrictEqual(line.annotations, {
				...call,
				startedAt: 0,
				source: "other",
				...tokens,
			})
		}).pipe(Effect.provide(logs.layer))
	},
)

it.effect(
	"a budget check that cannot read the database fails the call, and the log keeps the cause",
	() => {
		const logs = collect()
		return Effect.gen(function* () {
			const metered = meter(yield* model, call, {
				billing: billingOf({
					check: () =>
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
			assert.strictEqual(error.reason._tag, "UnknownError")
			const [line, ...rest] = logs.lines()
			assert.deepStrictEqual(rest, [])
			assert.ok(line !== undefined)
			assert.deepStrictEqual(line.message, [
				"OpenBot could not check the budgets",
			])
			assert.match(Cause.pretty(line.cause), /The database is down/)
			assert.deepStrictEqual(line.annotations, {
				organizationId: call.organizationId,
				providerId: call.providerId,
				modelId: call.modelId,
			})
		}).pipe(Effect.provide(logs.layer))
	},
)

it.effect(
	"a stop while a paced stream waits for room still records the usage of the call",
	() =>
		Effect.gen(function* () {
			const ended = yield* Deferred.make<void>()
			const recorded = yield* Ref.make<ReadonlyArray<Tokens>>([])
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
				billing: billingOf({
					check: () => Effect.void,
					record: (_call, _attribution, tokens) =>
						Ref.update(recorded, Arr.append(tokens)),
				}),
				// The buckets never get room for the output, so the output waits for ever.
				throttle: TokenThrottle.of({
					scopes: () => Effect.succeed([scope]),
					take: (_scopes, tokens) =>
						tokens === 0 ? Effect.void : Effect.never,
					charge: () => Effect.void,
				}),
			})
			const fiber = yield* metered
				.streamText({ prompt: "Write" })
				.pipe(Stream.runDrain, Effect.forkChild)
			yield* Deferred.await(ended)
			// The stop comes while the output of a finished call waits for room.
			yield* Fiber.interrupt(fiber)
			assert.deepStrictEqual(yield* Ref.get(recorded), [tokens])
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
				billing: billingOf({
					check: () =>
						Effect.flatMap(Ref.get(spent), (isSpent) =>
							isSpent
								? Effect.fail(
										SpendingBlocked.make({
											reason: "budget",
											budgetId: "budget_1",
											message: "The budget is spent.",
										}),
									)
								: Effect.void,
						),
					record: () => Effect.void,
				}),
				throttle: TokenThrottle.of({
					scopes: () => Effect.succeed([scope]),
					take: () => Deferred.await(room),
					charge: () => Effect.void,
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
