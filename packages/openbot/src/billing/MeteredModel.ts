import { Execution } from "@openbot-build/domain"
import type { Report } from "../errors/Report.ts"
import {
	Array as Arr,
	Cause,
	Context,
	Effect,
	Exit,
	Ref,
	Schema,
	Stream,
	Record as Rec,
	Result,
	Option,
} from "effect"
import {
	AiError,
	Prompt,
	Response,
	type LanguageModel,
	type DecisionModel,
	type Decision,
	Telemetry,
} from "effect/ai"
import {
	type Attribution,
	type Billing,
	type Call,
	type CallIdentity,
	type SpendingBlocked,
	type Tokens,
	tokensOf,
} from "./Billing.ts"
import type {
	TokenThrottle,
	Unavailable as TokenRateUnavailable,
} from "./TokenThrottle.ts"
import {
	type Methods,
	type Options,
	methodsOf,
	withMethods,
} from "../models/ModelMethods.ts"

/**
 * Finds who makes a model call, at the time of the call. The code that gives a
 * model to a Chat, the Rules judge or Bot memory provides it. It runs in the
 * fiber of the call, so it can read the Turn that is running.
 */
export const CurrentAttribution = Context.Reference<Effect.Effect<Attribution>>(
	"@openbot-build/openbot/billing/CurrentAttribution",
	{ defaultValue: () => Effect.succeed({ source: "other" }) },
)

/** A durable model attempt gives the meter its stable call ID. */
export const CurrentCallIdentity = Context.Reference<CallIdentity | undefined>(
	"@openbot-build/openbot/billing/CurrentCallIdentity",
	{
		defaultValue: () => undefined,
	},
)

/** A durable call checks its owner and rights in the reservation transaction. */
type Reservation = ReturnType<Billing["Service"]["reserve"]>
export const CurrentReservation = Context.Reference<
	(
		reserve: Reservation,
	) => Effect.Effect<
		Effect.Success<Reservation>,
		Effect.Error<Reservation> | AiError.AiError
	>
>("@openbot-build/openbot/billing/CurrentReservation", {
	defaultValue: () => (reserve) => reserve,
})

/** The current model step keeps provider usage even when output validation fails. */
export const CurrentUsage = Context.Reference<
	(usage: Response.Usage) => Effect.Effect<void>
>("@openbot-build/openbot/billing/CurrentUsage", {
	defaultValue: () => () => Effect.void,
})

const partSize = (parts: ReadonlyArray<Prompt.Part>) =>
	Arr.reduce(
		parts,
		0,
		(size, part) => size + (part.type === "text" ? part.text.length : 1024),
	)

/** Text is about four characters per token. Other parts get a rough size. */
const inputEstimate = (options: Options) =>
	Math.ceil(
		Arr.reduce(
			Prompt.make(options.prompt).content,
			0,
			(size, message) =>
				size +
				(message.role === "system"
					? message.content.length
					: partSize(message.content)),
		) / 4,
	)

/** Missing provider counts are unknown usage, not a confirmed zero. */
export const confirmed = (usage: Response.Usage) =>
	usage.inputTokens.total !== undefined &&
	usage.outputTokens.total !== undefined

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

const blocked = (method: string, error: SpendingBlocked): AiError.AiError =>
	AiError.make({
		module: "OpenBot",
		method,
		reason: AiError.QuotaExhaustedError.make({
			metadata: {
				openbot: {
					reason: error.reason,
					message: error.message,
					...(error.budgetId === undefined ? {} : { budgetId: error.budgetId }),
				},
			},
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

/** A stop keeps its interrupt. Other causes get a safe, saved reference. */
const saveFailure = (
	report: Report,
	operation: string,
	cause: Cause.Cause<unknown>,
) =>
	Cause.hasInterruptsOnly(cause)
		? Effect.failCause(
				Cause.fromReasons<never>(
					Arr.filter(cause.reasons, Cause.isInterruptReason),
				),
			)
		: Effect.flatMap(CurrentCallIdentity, (identity) =>
				report(operation, cause, identity?.executionId),
			)

/** Keep storage details in a sealed record and return its safe reference. */
const rateError =
	(method: string, report: Report) =>
	<A, R>(effect: Effect.Effect<A, TokenRateUnavailable, R>) =>
		effect.pipe(
			Effect.catchCause((cause) =>
				saveFailure(report, "model.tokenRate", cause).pipe(
					Effect.flatMap((failure) =>
						AiError.make({
							module: "OpenBot",
							method,
							reason: AiError.UnknownError.make({
								description: "OpenBot cannot check the token rate right now.",
								metadata: { openbot: failure },
							}),
						}),
					),
				),
			),
		)

/** The sealed cause keeps the data needed to repair a failed usage write. */
class LostUsage extends Context.Service<
	LostUsage,
	{
		readonly call: Call
		readonly callId: Execution.CallId
		readonly startedAt: number
		readonly attribution: Attribution
		readonly tokens: Tokens
	}
>()("@openbot-build/openbot/billing/MeteredModel/LostUsage") {}

/** How many parts of a stream OpenBot reads ahead from the provider while it slows the output. */
const readAhead = 4096

/** How long OpenBot waits to record the usage of a call before it saves a sealed error record. */
const recordTimeout = "30 seconds"

/**
 * A model that checks the budgets and credits before each call, and records the
 * usage after each call. A failed record saves a sealed cause for repair.
 * Once the provider gives an answer, a stop of the call does not cut off its record.
 *
 * When the settings give token rates, each call takes its estimate before it starts.
 * A stream then sends each piece of output only when the buckets have room for
 * it, so the output comes at an even speed. At the end, the real input and output
 * counts replace the estimates in the shared buckets.
 */
interface Services {
	readonly billing: Billing["Service"]
	readonly throttle: TokenThrottle["Service"]
	readonly report: Report
	/** The hook present when the registry builds its provider models. */
	readonly spanTransformer?: Telemetry.SpanTransformer | undefined
}

const account = (call: Call, services: Services) => {
	const { billing, throttle, report } = services
	const save = (operation: string, cause: Cause.Cause<unknown>) =>
		saveFailure(report, operation, cause).pipe(Effect.asVoid)
	const unknown = (id: Execution.CallId) =>
		billing.unknown(id).pipe(
			Effect.timeout(recordTimeout),
			Effect.catchCause((cause) =>
				save("model.unknownUsage", cause).pipe(
					Effect.annotateLogs({ callId: id }),
				),
			),
		)
	const before = (method: string, estimate: Tokens, attribution: Attribution) =>
		Effect.gen(function* () {
			const scopes = yield* throttle
				.scopes(call, attribution)
				.pipe(rateError(method, report))
			// Streams pace output as it arrives. Other methods reserve a rough answer too.
			const estimated =
				method === "streamText" ? estimate.inputUncached : totalOf(estimate)
			yield* throttle.take(scopes, estimated).pipe(rateError(method, report))
			// The check and the start time come after the wait, so they are for the
			// time at which the call really goes to the provider.

			const reserve = yield* CurrentReservation
			const started = yield* reserve(
				billing.reserve(
					call,
					attribution,
					estimate,
					yield* CurrentCallIdentity,
				),
			).pipe(
				Effect.catchCause((cause) => {
					const reason = cause.reasons[0]
					if (cause.reasons.length === 1 && reason?._tag === "Fail") {
						if (reason.error._tag === "AiError")
							return Effect.fail(reason.error)
						if (reason.error._tag === "SpendingBlocked")
							return Effect.fail(blocked(method, reason.error))
					}
					return saveFailure(report, "model.reserve", cause).pipe(
						Effect.flatMap((failure) =>
							AiError.make({
								module: "OpenBot",
								method,
								reason: AiError.UnknownError.make({
									description: "OpenBot cannot check the budgets right now.",
									metadata: { openbot: failure },
								}),
							}),
						),
					)
				}),
				(acquire) =>
					Effect.acquireRelease(acquire, (started) => unknown(started.id)),
			)
			return { attribution, ...started, scopes, estimated }
		})
	type Started = Effect.Success<ReturnType<typeof before>>
	/** Puts the tokens of a call into its buckets, less the tokens that its output already took. */
	const charge = (started: Started, tokens: Tokens, paced = 0) =>
		throttle
			.charge(started.scopes, totalOf(tokens) - started.estimated - paced)
			.pipe(Effect.catchCause((cause) => save("model.settleTokenRate", cause)))
	/** Adds the usage row of a call, and takes its cost from the credits. */
	const record = (started: Started, tokens: Tokens) =>
		billing.record(started.id, tokens).pipe(
			// Nothing can stop the record from outside, so a stuck database must not hold the call for ever.
			Effect.timeout(recordTimeout),
			Effect.catchCause((cause) =>
				save(
					"model.recordUsage",
					Cause.annotate(
						cause,
						Context.make(LostUsage, {
							call,
							callId: started.id,
							startedAt: started.startedAt,
							attribution: started.attribution,
							tokens,
						}),
					),
				).pipe(Effect.annotateLogs({ callId: started.id })),
			),
		)

	const after = (started: Started, usage: Response.Usage) =>
		Effect.gen(function* () {
			yield* (yield* CurrentUsage)(usage)
			if (!confirmed(usage)) return yield* unknown(started.id)
			const tokens = tokensOf(usage)
			yield* record(started, tokens)
			yield* charge(started, tokens)
		})
	return { before, after, charge, record, throttle, unknown }
}

export const meter = (
	model: LanguageModel.LanguageModel,
	call: Call,
	services: Services,
): LanguageModel.LanguageModel => {
	const {
		before: begin,
		after,
		charge,
		record,
		throttle,
		unknown,
	} = account(call, services)
	const before = (
		method: "generateText" | "generateObject" | "streamText",
		options: Options,
	) =>
		Effect.flatMap(CurrentAttribution, (attribution) =>
			Effect.flatMap(attribution, (value) =>
				begin(
					method,
					{
						inputUncached: inputEstimate(options),
						inputCacheRead: 0,
						inputCacheWrite: 0,
						outputText: 1024,
						outputReasoning: 0,
					},
					refine(value, method),
				),
			),
		)

	const plain = methodsOf(model)
	const methods: Methods = {
		// The provider charges for each answer, so a stop after the answer must
		// not cut off its record.
		generateText: (options) =>
			Effect.uninterruptibleMask((restore) =>
				Effect.gen(function* () {
					const started = yield* restore(before("generateText", options))
					return yield* restore(plain.generateText(options)).pipe(
						Effect.tap((response) => after(started, response.usage)),
					)
				}),
			).pipe(Effect.scoped),
		generateObject: (options) =>
			Effect.uninterruptibleMask((restore) =>
				Effect.gen(function* () {
					const started = yield* restore(before("generateObject", options))
					const current = Context.getOption(
						yield* Effect.context<never>(),
						Telemetry.CurrentSpanTransformer,
					)
					const previous =
						Option.getOrUndefined(current) ?? services.spanTransformer
					// Effect validates structured output before returning its usage. This
					// synchronous hook keeps the provider counts even when validation fails.
					let usage: Option.Option<Response.Usage> = Option.none()
					const result = yield* Effect.exit(
						restore(
							plain.generateObject(options).pipe(
								Effect.provideService(
									Telemetry.CurrentSpanTransformer,
									(response) => {
										for (const part of response.response) {
											if (part.type === "finish")
												usage = Option.some(part.usage)
										}
										previous?.(response)
									},
								),
							),
						),
					)
					if (Option.isSome(usage)) yield* after(started, usage.value)
					else if (Exit.isSuccess(result))
						yield* after(started, result.value.usage)
					return yield* result
				}),
			).pipe(Effect.scoped),
		streamText: (options) =>
			Stream.unwrap(
				Effect.gen(function* () {
					const started = yield* before("streamText", options)
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
					const counts = yield* Ref.make(Option.none<Tokens>())
					// The provider can finish before the reader gets the buffered output.
					// Closing the stream still settles its shared rate from the saved counts.
					yield* Effect.addFinalizer(() =>
						Effect.gen(function* () {
							const usage = yield* Ref.get(counts)
							if (Option.isSome(usage))
								yield* charge(started, usage.value, yield* Ref.get(paced))
						}),
					)
					return stream.pipe(
						// The provider bills the call when it sends `finish`. This step comes
						// before the read-ahead buffer, so a stop while the output waits for
						// room does not lose the record. Only the throttle charge waits for the output.
						Stream.tap((part) =>
							part.type === "finish"
								? Effect.uninterruptible(
										Effect.flatMap(CurrentUsage, (capture) =>
											capture(part.usage),
										).pipe(
											Effect.andThen(
												confirmed(part.usage)
													? Ref.set(
															counts,
															Option.some(tokensOf(part.usage)),
														).pipe(
															Effect.andThen(
																record(started, tokensOf(part.usage)),
															),
														)
													: unknown(started.id),
											),
										),
									)
								: Effect.void,
						),
						// Read on from the provider while the output waits for room.
						Stream.buffer({ capacity: readAhead }),
						Stream.tap((part) => {
							const tokens = estimate(part)
							return tokens === 0
								? Effect.void
								: Effect.uninterruptibleMask((restore) =>
										Effect.gen(function* () {
											// Save the local count only after the shared debit commits. A stop
											// while waiting cannot turn an uncommitted debit into saved usage.
											const wait = yield* throttle
												.charge(started.scopes, tokens)
												.pipe(rateError("streamText", services.report))
											yield* Ref.update(paced, (taken) => taken + tokens)
											if (wait > 0) yield* restore(Effect.sleep(wait))
										}),
									)
						}),
					)
				}),
			),
	}
	return withMethods(model, methods)
}

/** Decision providers report counts with the same meaning as language providers. */
export const decisionUsage = (
	usage: DecisionModel.DecisionUsage,
): Response.Usage =>
	Response.Usage.make({
		inputTokens: {
			total: usage.inputTokens,
			uncached: usage.inputTokens,
			cacheRead: undefined,
			cacheWrite: undefined,
		},
		outputTokens: {
			total: usage.outputTokens,
			text: usage.outputTokens,
			reasoning: undefined,
		},
	})

/** Keep the strict decision API after metering the provider response. */
const requireAnswers = <D extends Record<string, Decision.Any>>(
	outcomes: Decision.Outcomes<D>,
) =>
	Effect.gen(function* () {
		const entries = Rec.toEntries(outcomes)
		const refused = Arr.filter(
			entries,
			([, result]) =>
				Result.isFailure(result) && result.failure.reason === "Refused",
		)
		if (refused.length > 0)
			return yield* AiError.make({
				module: "DecisionModel",
				method: "decide",
				reason: AiError.ContentPolicyError.make({
					description: `Provider refused to answer decisions ${Arr.join(
						Arr.map(refused, ([key]) => `"${key}"`),
						", ",
					)}`,
				}),
			})
		const missing = Arr.findFirst(Rec.values(outcomes), Result.isFailure)
		if (Option.isSome(missing))
			return yield* AiError.make({
				module: "DecisionModel",
				method: "decide",
				reason: AiError.InvalidOutputError.make({
					description: missing.value.failure.description,
				}),
			})
		// Each key keeps the answer type of its definition after the failure checks.
		const answers: Record<string, Decision.Answer<Decision.Any>> = Rec.map(
			outcomes,
			(result) => Result.getOrThrow(result),
		)
		return answers as Decision.Answers<D>
	})

/** Both decision methods use the same budget, reservation and usage rules. */
export const meterDecision = (
	model: DecisionModel.DecisionModel,
	call: Call,
	services: Services,
): DecisionModel.DecisionModel => {
	const { before, after } = account(call, services)
	const run = <
		A extends { readonly usage: DecisionModel.DecisionUsage },
		E,
		R,
		InputR,
	>(
		method: string,
		input: Effect.Effect<Schema.Json, Schema.SchemaError, InputR>,
		images: number,
		send: Effect.Effect<A, E, R>,
	) =>
		Effect.uninterruptibleMask((restore) =>
			Effect.gen(function* () {
				const encoded = yield* restore(
					input.pipe(
						Effect.flatMap(
							Schema.encodeEffect(Schema.fromJsonString(Schema.Json)),
						),
						Effect.mapError((error) =>
							AiError.make({
								module: "OpenBot",
								method,
								reason: AiError.InvalidUserInputError.make({
									description: error.message,
								}),
							}),
						),
					),
				)
				const started = yield* restore(
					before(
						method,
						{
							inputUncached: Math.ceil(encoded.length / 4) + images * 1024,
							inputCacheRead: 0,
							inputCacheWrite: 0,
							outputText: 1024,
							outputReasoning: 0,
						},
						yield* yield* CurrentAttribution,
					),
				)
				return yield* restore(send).pipe(
					Effect.tap((result) => after(started, decisionUsage(result.usage))),
				)
			}),
		).pipe(Effect.scoped)
	const settled: DecisionModel.DecisionModel["decideSettled"] = (
		definition,
		options,
	) =>
		run(
			"decideSettled",
			Schema.encodeEffect(Schema.toCodecJson(definition.input))(options.input),
			options.images?.length ?? 0,
			model.decideSettled(definition, options),
		)
	return {
		...model,
		// Effect's strict decide drops usage on an invalid answer. Meter the settled
		// response first, then apply the same strict answer checks.
		decide: (definition, options) =>
			settled(definition, options).pipe(
				Effect.flatMap(({ outcomes, ...response }) =>
					requireAnswers(outcomes).pipe(
						Effect.map((answers) => ({ answers, ...response })),
					),
				),
			),
		decideSettled: settled,
	}
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
