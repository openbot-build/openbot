// `meter` wraps one model object. A pipeable form does not help.
// @effect-diagnostics missingPipeableSignature:off
import { Clock, Context, Effect, Stream } from "effect"
import { AiError, type LanguageModel, type Response } from "effect/ai"
import {
	type Attribution,
	type Billing,
	type Call,
	type SpendingBlocked,
	tokensOf,
	type BillingStorageError,
} from "./Billing.ts"

/**
 * Finds who makes a model call, at the time of the call. The code that gives a
 * model to a Session, the Rules judge or Agent memory provides it. It runs in the
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
 * A Session streams its model steps. The same model also writes summaries
 * (compaction) with `generateText` and Session memory with `generateObject`.
 */
const refine = (
	attribution: Attribution,
	method: "generateText" | "generateObject" | "streamText",
): Attribution =>
	attribution.source !== "turn" || method === "streamText"
		? attribution
		: {
				...attribution,
				source: method === "generateText" ? "compaction" : "session_memory",
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

interface Methods {
	readonly generateText: (
		options: unknown,
	) => Effect.Effect<{ readonly usage: Response.Usage }, AiError.AiError>
	readonly generateObject: (
		options: unknown,
	) => Effect.Effect<{ readonly usage: Response.Usage }, AiError.AiError>
	readonly streamText: (
		options: unknown,
	) => Stream.Stream<Response.StreamPart<{}>, AiError.AiError>
}

/**
 * A model that checks the budgets and credits before each call, and records the
 * usage after each call. A failed record only writes a log, so the answer is not lost.
 */
export const meter = (
	model: LanguageModel.LanguageModel,
	call: Call,
	billing: Billing["Service"],
): LanguageModel.LanguageModel => {
	const before = (method: "generateText" | "generateObject" | "streamText") =>
		Effect.gen(function* () {
			const attribution = refine(yield* yield* CurrentAttribution, method)
			const startedAt = yield* Clock.currentTimeMillis
			yield* billing
				.check(call, attribution)
				.pipe(Effect.mapError((error) => blocked(method, error)))
			return { attribution, startedAt }
		})
	const after = (
		started: { readonly attribution: Attribution; readonly startedAt: number },
		usage: Response.Usage,
	) =>
		billing
			.record(call, started.attribution, tokensOf(usage), started.startedAt)
			.pipe(
				Effect.catch((error) =>
					Effect.logWarning("OpenBot could not record model usage", error),
				),
			)
	// The methods are generic and overloaded. The wrapper only passes the options
	// through and returns the same result, so it uses this plain form of them.
	const plain = model as unknown as Methods
	const methods: Methods = {
		generateText: (options) =>
			Effect.gen(function* () {
				const started = yield* before("generateText")
				const response = yield* plain.generateText(options)
				yield* after(started, response.usage)
				return response
			}),
		generateObject: (options) =>
			Effect.gen(function* () {
				const started = yield* before("generateObject")
				const response = yield* plain.generateObject(options)
				yield* after(started, response.usage)
				return response
			}),
		streamText: (options) =>
			Stream.unwrap(
				Effect.map(before("streamText"), (started) =>
					plain
						.streamText(options)
						.pipe(
							Stream.tap((part) =>
								part.type === "finish"
									? after(started, part.usage)
									: Effect.void,
							),
						),
				),
			),
	}
	return {
		...model,
		...(methods as unknown as Pick<LanguageModel.LanguageModel, keyof Methods>),
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
	const plain = model as unknown as Methods
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
	return {
		...model,
		...(methods as unknown as Pick<LanguageModel.LanguageModel, keyof Methods>),
	}
}
