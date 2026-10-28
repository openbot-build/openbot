import { Config } from "@openbot-build/core"
import { Execution } from "@openbot-build/domain"
import {
	Array as Arr,
	Clock,
	Context,
	Effect,
	Layer,
	Option,
	Schema,
} from "effect"
import { LanguageModel, Prompt, Response } from "effect/ai"
import { Billing, periodStart } from "../billing/Billing.ts"
import { attribute } from "../billing/MeteredModel.ts"
import * as Check from "../authorization/Check.ts"
import { Calls } from "../execution/Calls.ts"
import * as Permits from "../execution/Permits.ts"
import { Store, type Fence } from "../execution/Store.ts"
import * as ModelCalls from "../models/ModelCalls.ts"
import { ModelRegistry } from "../models/ModelRegistry.ts"
import { MemoryBot, MemoryBudgetSpent, memoryBotId } from "./MemoryBot.ts"
import type { Home } from "./BotMemories.ts"

const Request = Schema.Struct({
	selection: Config.Selection,
	prompt: Prompt.Prompt,
	kind: Schema.Literals(["text", "object"]),
	name: Schema.String,
})
const requestCodec = Schema.toCodecJson(Request)
const Answer = Schema.Struct({ value: Schema.Json, usage: Response.Usage })

/** Memory uses the same saved model calls and confirmed usage as a Turn. */
const make = Effect.gen(function* () {
	const registry = yield* ModelRegistry

	const models = yield* ModelCalls.make
	const store = yield* Store
	const calls = yield* Calls
	const checks = yield* Check.make
	const memory = yield* MemoryBot
	const billing = yield* Billing
	const permits = yield* Permits.make
	const run = Effect.fn("MemoryModels.run")(function* <A, E>(
		fence: Fence,
		step: string,
		home: Home,
		options: {
			readonly schema: Schema.Codec<A, Schema.Json>
			readonly send: (
				prompt: Prompt.Prompt,
			) => Effect.Effect<
				{ readonly value: A; readonly usage: Response.Usage },
				E,
				LanguageModel.LanguageModel
			>
			readonly kind: "text" | "object"
			readonly name: string
			readonly prompt: (
				instructions: string,
			) => Effect.Effect<Prompt.Prompt, Execution.StorageError>
		},
	) {
		yield* calls.authorize(fence, "replay")
		const saved = yield* store.loadMember(fence)
		const settings = yield* memory.settings(home)
		const history = yield* store.calls(fence)
		const prior = Arr.findFirst(history, (call) => call.step === step)
		// A retry uses the same prompt and model choice, even if memory or settings changed.
		const request = Option.isSome(prior)
			? yield* Schema.decodeEffect(requestCodec)(prior.value.input)
			: {
					selection: yield* registry.helperSelection(
						saved.identity.actor.organizationId,
						"botMemoryModel",
					),
					prompt: yield* options.prompt(settings.instructions),
					kind: options.kind,
					name: options.name,
				}
		if (request.kind !== options.kind || request.name !== options.name)
			return yield* Execution.Conflict.make({ id: fence.id })
		const beforeSend = Effect.gen(function* () {
			yield* Check.model(checks, saved.identity, request.selection)
			const current = yield* memory.settings(home)
			if (current.budget !== undefined) {
				const now = yield* Clock.currentTimeMillis
				const spent = yield* billing.botSpend(
					memoryBotId(home),
					periodStart(current.budget.period, now),
				)
				if (spent >= current.budget.limitMicros)
					return yield* MemoryBudgetSpent.make({ home })
			}
		})
		const send = Effect.gen(function* () {
			const model = yield* registry.resolve(
				saved.identity.actor.organizationId,
				request.selection,
			)
			const response = yield* options.send(request.prompt).pipe(
				Effect.flatMap((result) =>
					Schema.encodeEffect(options.schema)(result.value).pipe(
						Effect.map((value) => ({ value, usage: result.usage })),
					),
				),
				Effect.provideService(LanguageModel.LanguageModel, model),
			)
			return response
		}).pipe(
			attribute({
				source: "bot_memory",
				botId: memoryBotId(home),
				userId: saved.identity.actor.userId,
				...(saved.identity.actor.tokenId === undefined
					? {}
					: { tokenId: saved.identity.actor.tokenId }),
			}),
		)
		const input = yield* Schema.encodeEffect(requestCodec)(request)
		const duration =
			options.name === "bot_memory_operations" ? "2 minutes" : "15 seconds"
		const latest = Arr.reduce(
			history,
			Option.none<Execution.Call>(),
			(found, call) =>
				call.step !== step ||
				(Option.isSome(found) && found.value.attempt > call.attempt)
					? found
					: Option.some(call),
		)
		const invoke = (permit?: Permits.Permit) =>
			models.run(fence, step, input, {
				codec: Schema.toCodecJson(Answer),
				usage: (answer) => answer.usage,
				beforeSend:
					permit === undefined
						? Effect.fail(Execution.Conflict.make({ id: fence.id }))
						: beforeSend.pipe(Effect.andThen(permits.check(permit))),
				send: () => send.pipe(Effect.timeout(duration)),
			})
		// A saved answer needs no new place. The replay path cannot send a new call.
		const response = yield* (
			Option.isSome(latest) && latest.value.status === "completed"
				? invoke()
				: permits.use(
						fence,
						{
							scope: home.organizationId,
							resource: { kind: "BotMemory", id: home.bot },
						},
						{
							limit: memory
								.settings(home)
								.pipe(Effect.map((current) => current.concurrency)),
							duration,
						},
						invoke,
					)
		).pipe(Effect.timeout(duration))

		return yield* Schema.decodeEffect(options.schema)(response.result.value)
	})
	return { run }
})
export class MemoryModels extends Context.Service<
	MemoryModels,
	Effect.Success<typeof make>
>()("@openbot-build/openbot/bots/MemoryModels") {}
export const layer = Layer.effect(MemoryModels, make)
