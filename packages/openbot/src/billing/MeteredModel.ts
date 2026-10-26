import { Cause, Clock, Context, Effect, Ref, Stream } from "effect"
import { AiError, type LanguageModel, type Response } from "effect/ai"
import {
	type Attribution,
	type Billing,
	type Call,
	type SpendingBlocked,
	type Tokens,
	tokensOf,
	type BillingStorageError,
} from "./Billing.ts"
import type { TokenThrottle } from "./TokenThrottle.ts"
import { type Methods, methodsOf, withMethods } from "../models/ModelMethods.ts"

/**
 * Finds who makes a model call, at the time of the call. The code that gives a
 * model to a Chat, the Rules judge or Bot memory provides it. It runs in the
 * fiber of the call, so it can read the Turn that is running.
 */
export const CurrentAttribution = Context.Reference<Effect.Effect<Attribution>>(
	"@openbot-build/openbot/billing/CurrentAttribution",
	{ defaultValue: () => Effect.succeed({ source: "other" }) },
)

/** Runs an effect with a fixed attribution for its model calls. */
export const attribute =
	(attribution: Attribution | Effect.Effect<Attribution>) =>
	<A, E, R>(effect: Effect.Effect<A, E, R>) =>
		Effect.provideService(
			effect,
			CurrentAttribution,
			Effect.isEffect(attribution) ? attribution : Effect.succeed(attribution),
		)

/**
 * A Chat streams its model steps. The same model also writes summaries
 * (compaction) with `generateText`. Other calls of it count as `other`.
 */
const refine = (
	attribution: Attribution,
	method: "generateText" | "generateObject" | "streamText",
): Attribution =>
	attribution.source !== "turn" || method === "streamText"
		? attribution
		: {
				...attribution,
				source: method === "generateText" ? "compaction" : "other",
			}

const blocked = (
	method: string,
	error: SpendingBlocked | BillingStorageError,
): AiError.AiError =>
	AiError.make({
		module: "OpenBot",
		method,
		reason:
			error._tag === "SpendingBlocked"
				? AiError.QuotaExhaustedError.make({
						metadata: {
							openbot: {
								reason: error.reason,
								message: error.message,
								...(error.budgetId === undefined
									? {}
									: { budgetId: error.budgetId }),
							},
						},
					})
				: AiError.UnknownError.make({
						description: "OpenBot cannot check the budgets right now.",
					}),
	})

/** A rough count of the tokens in a piece of streamed text: about four characters each. */
const estimate = (part: Response.StreamPart<{}>) =>
	part.type === "text-delta" ||
	part.type === "reasoning-delta" ||
	part.type === "tool-params-delta"
		? Math.ceil(part.delta.length / 4)
		: 0

const totalOf = (tokens: Tokens) =>
	tokens.inputUncached +
	tokens.inputCacheRead +
	tokens.inputCacheWrite +
	tokens.outputText +
	tokens.outputReasoning

/** How many parts of a stream OpenBot reads ahead from the provider while it slows the output. */
const readAhead = 4096

/** How long OpenBot waits to record the usage of a call before it gives up and logs it. */
const recordTimeout = "30 seconds"

/**
 * A model that checks the budgets and credits before each call, and records the
 * usage after each call. A failed record only writes a log, so the answer is not lost.
 * Once the provider gives an answer, a stop of the call does not cut off its record.
 *
 * When the settings give token rates, each call first waits until its token buckets are out of debt.
 * A stream then sends each piece of output only when the buckets have room for
 * it, so the output comes at an even speed. At the end, the real input and output
 * tokens go into the buckets, and the next call waits for them.
 */
export const meter = (
	model: LanguageModel.LanguageModel,
	call: Call,
	services: {
		readonly billing: Billing["Service"]
		readonly throttle: TokenThrottle["Service"]
	},
): LanguageModel.LanguageModel => {
	const { billing, throttle } = services
	const before = (method: "generateText" | "generateObject" | "streamText") =>
		Effect.gen(function* () {
			const attribution = refine(yield* yield* CurrentAttribution, method)
			const scopes = yield* throttle.scopes(call, attribution)
			yield* throttle.take(scopes, 0)
			// The check and the start time come after the wait, so they are for the
			// time at which the call really goes to the provider.
			const startedAt = yield* Clock.currentTimeMillis
			yield* billing.check(call, attribution).pipe(
				// The model error cannot carry the storage failure, so the log keeps it.
				Effect.tapErrorTag("BillingStorageError", (error) =>
					Effect.logWarning(
						"OpenBot could not check the budgets",
						Cause.fail(error),
					).pipe(
						Effect.annotateLogs({
							organizationId: call.organizationId,
							providerId: call.providerId,
							modelId: call.modelId,
						}),
					),
				),
				Effect.mapError((error) => blocked(method, error)),
			)
			return { attribution, startedAt, scopes }
		})
	type Started = Effect.Success<ReturnType<typeof before>>
	/** Puts the tokens of a call into its buckets, less the tokens that its output already took. */
	const charge = (started: Started, tokens: Tokens, paced = 0) =>
		throttle.charge(started.scopes, totalOf(tokens) - paced)
	/** Adds the usage row of a call, and takes its cost from the credits. */
	const record = (started: Started, tokens: Tokens) =>
		billing.record(call, started.attribution, tokens, started.startedAt).pipe(
			// Nothing can stop the record from outside, so a stuck database must not hold the call for ever.
			Effect.timeout(recordTimeout),
			// The log has every value of the lost usage row, so it can be added again.
			Effect.catch((error) =>
				Effect.logWarning(
					"OpenBot could not record model usage",
					Cause.fail(error),
				).pipe(
					Effect.annotateLogs({
						organizationId: call.organizationId,
						providerId: call.providerId,
						providerOwner: call.providerOwner,
						modelId: call.modelId,
						startedAt: started.startedAt,
						...started.attribution,
						...tokens,
					}),
				),
			),
		)
	const after = (started: Started, usage: Response.Usage) => {
		const tokens = tokensOf(usage)
		return Effect.andThen(charge(started, tokens), record(started, tokens))
	}
	const plain = methodsOf(model)
	const methods: Methods = {
		// The provider charges for each answer, so a stop after the answer must
		// not cut off its record.
		generateText: (options) =>
			Effect.uninterruptibleMask((restore) =>
				Effect.gen(function* () {
					const started = yield* restore(before("generateText"))
					const response = yield* restore(plain.generateText(options))
					yield* after(started, response.usage)
					return response
				}),
			),
		generateObject: (options) =>
			Effect.uninterruptibleMask((restore) =>
				Effect.gen(function* () {
					const started = yield* restore(before("generateObject"))
					const response = yield* restore(plain.generateObject(options))
					yield* after(started, response.usage)
					return response
				}),
			),
		streamText: (options) =>
			Stream.unwrap(
				Effect.gen(function* () {
					const started = yield* before("streamText")
					const stream = plain.streamText(options)
					if (started.scopes.length === 0)
						return stream.pipe(
							Stream.tap((part) =>
								part.type === "finish"
									? Effect.uninterruptible(after(started, part.usage))
									: Effect.void,
							),
						)
					// The tokens that the output already took from the buckets.
					const paced = yield* Ref.make(0)
					return stream.pipe(
						// The provider bills the call when it sends `finish`. This step comes
						// before the read-ahead buffer, so a stop while the output waits for
						// room does not lose the record. Only the throttle charge waits for the output.
						Stream.tap((part) =>
							part.type === "finish"
								? Effect.uninterruptible(record(started, tokensOf(part.usage)))
								: Effect.void,
						),
						// Read on from the provider while the output waits for room.
						Stream.buffer({ capacity: readAhead }),
						Stream.tap((part) => {
							if (part.type === "finish")
								return Effect.flatMap(Ref.get(paced), (taken) =>
									charge(started, tokensOf(part.usage), taken),
								)
							const tokens = estimate(part)
							return tokens === 0
								? Effect.void
								: Effect.andThen(
										Ref.update(paced, (taken) => taken + tokens),
										throttle.take(started.scopes, tokens),
									)
						}),
					)
				}),
			),
	}
	return withMethods(model, methods)
}

/**
 * Gives the model calls of a model this attribution, wherever the model goes.
 * The attribution runs at the time of each call.
 */
export const withAttribution = (
	model: LanguageModel.LanguageModel,
	attribution: Effect.Effect<Attribution>,
): LanguageModel.LanguageModel => {
	const plain = methodsOf(model)
	const methods: Methods = {
		generateText: (options) =>
			Effect.provideService(
				plain.generateText(options),
				CurrentAttribution,
				attribution,
			),
		generateObject: (options) =>
			Effect.provideService(
				plain.generateObject(options),
				CurrentAttribution,
				attribution,
			),
		streamText: (options) =>
			Stream.provideService(
				plain.streamText(options),
				CurrentAttribution,
				attribution,
			),
	}
	return withMethods(model, methods)
}
