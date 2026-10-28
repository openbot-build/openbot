import * as ToolDefinitions from "./ToolDefinitions.ts"
import { Execution } from "@openbot-build/domain"
import { CurrentAttribution } from "../billing/MeteredModel.ts"
import * as ModelCalls from "../models/ModelCalls.ts"
import { Billing } from "../billing/Billing.ts"
import {
	ModelStep,
	SummaryCompaction,
	ContextCompaction,
	Config,
} from "@openbot-build/core"
import {
	Array as Arr,
	Clock,
	Crypto,
	Cause,
	Context,
	Effect,
	Layer,
	Record as Rec,
	Ref,
	Option,
	Schema,
} from "effect"
import { LanguageModel, Prompt, Tool, Toolkit, type Response } from "effect/ai"
import { Records, category } from "../errors/Records.ts"
import { Hex } from "effect/encoding"
import { Calls } from "../execution/Calls.ts"
import { Store, type Fence } from "../execution/Store.ts"

import { TurnAccess } from "./TurnAccess.ts"

const CallRetry = Context.Reference<"read_only" | "never">(
	"@openbot-build/openbot/chats/ModelSteps/CallRetry",
	{ defaultValue: () => "read_only" },
)

const resultCodec = Schema.toCodecJson(ModelStep.Result)
const promptCodec = Schema.toCodecJson(Prompt.Prompt)

/** Build this layer in the Turn scope with its selected model and tools. */
const make = Effect.gen(function* () {
	const model = yield* LanguageModel.LanguageModel
	const retry = yield* CallRetry
	const access = yield* TurnAccess
	const store = yield* Store
	const calls = yield* Calls
	const modelCalls = yield* ModelCalls.make
	const crypto = yield* Crypto.Crypto
	const errors = yield* Records
	const run = Effect.fn("ModelSteps.run")(function* <
		Tools extends Record<string, Tool.Any>,
	>(
		fence: Fence,
		step: string,
		selection: Config.Selection,
		input: {
			readonly prompt: Prompt.Prompt
			readonly toolkit: Toolkit.Toolkit<Tools>
			readonly toolChoice?: LanguageModel.GenerateTextOptions<Tools>["toolChoice"]
		},
		onPart: (
			part: Response.StreamPart<Tools, "deferred">,
		) => Effect.Effect<void> = () => Effect.void,
		purpose: "turn" | "compaction" = "turn",
	) {
		yield* calls.authorize(fence, "replay")
		const prior = yield* store.latestCall(fence, step)
		const request = {
			purpose,
			selection: yield* Schema.encodeEffect(
				Schema.toCodecJson(Config.Selection),
			)(selection),
			prompt: yield* Schema.encodeEffect(promptCodec)(input.prompt),
			toolChoice: input.toolChoice ?? null,
		}
		const savedInput = Option.isSome(prior)
			? prior.value.input
			: yield* Schema.decodeUnknownEffect(Schema.Json)({
					...request,
					tools: yield* Effect.forEach(
						Rec.values(input.toolkit.tools),
						ToolDefinitions.capture,
					),
				})
		const saved = yield* Schema.decodeUnknownEffect(
			Schema.Struct({
				purpose: Schema.Literals(["turn", "compaction"]),
				selection: Schema.Json,
				prompt: Schema.Json,
				toolChoice: Schema.Json,
				tools: Schema.Array(ToolDefinitions.Definition),
			}),
		)(savedInput)
		if (
			!Schema.toEquivalence(Schema.Json)(request, {
				purpose: saved.purpose,
				selection: saved.selection,
				prompt: saved.prompt,
				toolChoice: saved.toolChoice,
			})
		)
			return yield* Execution.Conflict.make({ id: fence.id })
		// A retry keeps the request's tools. Deferred parts have raw JSON; no handler result is decoded here.
		const toolkit = Toolkit.make(
			...Arr.map(saved.tools, (tool) =>
				Tool.dynamic(tool.name, {
					...(tool.description === undefined
						? {}
						: { description: tool.description }),
					parameters: tool.parameters,
					success: Schema.Json,
				}),
			),
		)

		return yield* modelCalls.run(fence, step, savedInput, {
			codec: resultCodec,
			retry,
			usage: (result) => result.usage,
			beforeSend: access.model(fence, selection),
			send: (call) =>
				Effect.gen(function* () {
					const attribution = yield* CurrentAttribution
					const pending = yield* Ref.make("")
					const lastFlush = yield* Ref.make(yield* Clock.currentTimeMillis)
					const flush = Effect.gen(function* () {
						const text = yield* Ref.getAndSet(pending, "")
						if (text.length === 0) return
						yield* store.commit(
							fence,
							{ events: [{ _tag: "Text", step, attempt: call.attempt, text }] },
							Effect.void,
						)
						yield* Ref.set(lastFlush, yield* Clock.currentTimeMillis)
					})
					const result = yield* ModelStep.run<
						typeof toolkit.tools,
						Effect.Error<typeof flush>,
						never
					>({ ...input, toolkit }, (part) =>
						Effect.gen(function* () {
							if (purpose === "compaction" || part.type !== "text-delta")
								return yield* onPart(
									part as Response.StreamPart<Tools, "deferred">,
								)
							const text = yield* Ref.updateAndGet(
								pending,
								(text) => text + part.delta,
							)
							if (
								text.length >= 256 ||
								(yield* Clock.currentTimeMillis) -
									(yield* Ref.get(lastFlush)) >=
									50
							)
								yield* flush
							yield* onPart(part as Response.StreamPart<Tools, "deferred">)
						}),
					).pipe(
						Effect.provideService(LanguageModel.LanguageModel, model),
						Effect.provideService(
							CurrentAttribution,
							purpose === "compaction"
								? Effect.map(attribution, (current) => ({
										...current,
										source: "compaction" as const,
									}))
								: attribution,
						),
						Effect.onExit(() => flush),
					)
					return result
				}),
		})
	})
	/** A summary uses the same saved calls, attempts and usage as a normal model step. */
	const summarize = (
		fence: Fence,
		selection: Config.Selection,
		input: ContextCompaction.NonNativeRequest,
	) =>
		Effect.gen(function* () {
			yield* calls.authorize(fence, "replay")
			const prepared = yield* SummaryCompaction.prepare(input)
			if (prepared._tag === "Unchanged") return prepared.window
			const encoded = yield* Schema.encodeEffect(
				Schema.fromJsonString(Schema.Json),
			)({
				selection: yield* Schema.encodeEffect(
					Schema.toCodecJson(Config.Selection),
				)(selection),
				prompt: yield* Schema.encodeEffect(promptCodec)(prepared.prompt),
			})
			const hash = yield* crypto
				.digest("SHA-256", new TextEncoder().encode(encoded))
				.pipe(Effect.map(Hex.encode))
			const saved = yield* run(
				fence,
				`summary:${hash}`,
				selection,
				{
					prompt: prepared.prompt,
					toolkit: Toolkit.make(),
					toolChoice: "none",
				},
				() => Effect.void,
				"compaction",
			)
			const text = Arr.join(
				Arr.flatMap(saved.result.output.content, (message) =>
					message.role === "assistant"
						? Arr.flatMap(message.content, (part) =>
								part.type === "text" ? [part.text] : [],
							)
						: [],
				),
				"",
			)
			return yield* prepared.complete(text, saved.result.finishReason)
		}).pipe(
			Effect.catchCause(
				(
					cause,
				): Effect.Effect<
					never,
					ContextCompaction.ContextCompactionError | Execution.OutcomeUnknown
				> => {
					if (Cause.hasInterruptsOnly(cause))
						return Effect.failCause(
							Cause.fromReasons<never>(
								Arr.filter(cause.reasons, Cause.isInterruptReason),
							),
						)
					const reason = cause.reasons[0]
					if (
						cause.reasons.length === 1 &&
						reason?._tag === "Fail" &&
						Schema.is(Execution.OutcomeUnknown)(reason.error)
					) {
						const error = reason.error
						return Effect.failCause(Cause.map(cause, () => error))
					}
					return errors.record(cause, category(cause), fence.id).pipe(
						Effect.orDie,
						Effect.flatMap((failure) =>
							Effect.fail(
								ContextCompaction.ContextCompactionError.make({
									reason: "request-failed",
									message: "The model could not make the summary",
									cause: failure,
								}),
							),
						),
					)
				},
			),
		)

	const executor =
		(
			fence: Fence,
			selection: Config.Selection,
		): ModelStep.Executor<Effect.Error<ReturnType<typeof run>>> =>
		(position, input, onPart) =>
			run(fence, `model:${position.item}`, selection, input, onPart).pipe(
				Effect.map((saved) => saved.result),
			)
	return { run, executor, summarize }
})

export class ModelSteps extends Context.Service<
	ModelSteps,
	Effect.Success<typeof make>
>()("@openbot-build/openbot/chats/ModelSteps") {}
export const layer = Layer.effect(ModelSteps, make)

/** Build the adapters once. Each call builds its services with the model selected by core. */
export const makeExecutors = (
	fence: Fence,
	selection: Config.Selection,
	retry: "read_only" | "never" = "read_only",
) =>
	Effect.gen(function* () {
		const services = yield* Effect.context<
			Store | Calls | Billing | Crypto.Crypto | Records | TurnAccess
		>().pipe(
			Effect.map(
				Context.pick(Store, Calls, Billing, Crypto.Crypto, Records, TurnAccess),
			),
		)
		const selected = make.pipe(
			Effect.provideContext(services),
			Effect.provideService(CallRetry, retry),
		)
		const executeModel: ReturnType<Effect.Success<typeof make>["executor"]> = (
			position,
			input,
			onPart,
		) =>
			selected.pipe(
				Effect.flatMap((steps) =>
					steps.executor(fence, selection)(position, input, onPart),
				),
			)
		const summarize = (
			selection: Config.Selection,
			input: ContextCompaction.NonNativeRequest,
		) =>
			selected.pipe(
				Effect.flatMap((steps) => steps.summarize(fence, selection, input)),
			)
		return { executeModel, summarize }
	})
