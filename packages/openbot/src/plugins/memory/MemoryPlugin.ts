import { Bot, Plugin, type Session, type Turn } from "@openbot-build/core"
import { Effect, Option, Stream } from "effect"
import { LanguageModel, Prompt } from "effect/ai"
import * as Memory from "./Memory.ts"
import * as MemoryConsolidation from "./MemoryConsolidation.ts"
import * as MemoryRules from "./MemoryRules.ts"
import * as LanguageModelMemory from "./LanguageModelMemory.ts"

/**
 * The memory plugin. In each Turn it adds the active entries to the instructions.
 * After a completed Turn it learns new entries from the new history.
 * `settings` gives the switches for the Turn. The host decides where they come from.
 * `languageModel` gives the model that learns the entries. The host picks it for the Turn.
 */
export const make = <SE = never, LE = never>(
	options: Memory.Options & {
		readonly settings: Effect.Effect<Memory.Settings, SE, Bot.Context>
		readonly languageModel: Effect.Effect<
			LanguageModel.LanguageModel,
			LE,
			Bot.Context
		>
	},
) => {
	const policy = options.policy ?? MemoryRules.policy
	const model = options.model ?? LanguageModelMemory.model
	return Plugin.make({ id: Memory.pluginId, store: Memory.store })(
		({ store }) =>
			Effect.succeed((next, input) =>
				Stream.unwrap(
					Effect.gen(function* () {
						const memory = yield* store
						const settings = yield* options.settings
						// A host action Turn has no model step, so memory does not learn from it.
						const generate =
							settings.generate &&
							(yield* Bot.Context).options.action === undefined
						const text = settings.use
							? policy.project(
									Option.getOrElse(yield* memory.get, Memory.empty),
								)
							: ""
						const consolidate = (event: {
							readonly view: Session.View
							readonly turn: Turn.Record
						}) =>
							Effect.gen(function* () {
								yield* MemoryConsolidation.run({
									model,
									policy,
									state: Option.getOrElse(yield* memory.get, Memory.empty),
									history: event.view.state.value.conversation.history,
									update: (apply) =>
										memory.modifyEffect((current) =>
											apply(Option.getOrElse(current, Memory.empty)).pipe(
												Effect.map(
													(next) => [undefined, Option.some(next)] as const,
												),
											),
										),
								}).pipe(
									Effect.provideService(
										LanguageModel.LanguageModel,
										yield* options.languageModel,
									),
								)
							}).pipe(
								// The Turn is already complete. A memory failure must not fail it.
								// The next completed Turn reads the same Items again.
								Effect.catch((error) =>
									Effect.logError("Memory consolidation failed", error).pipe(
										Effect.annotateLogs({
											source: "turn",
											operation: "memory.consolidate",
											sessionId: event.view.session.id,
											turnId: event.turn.id,
										}),
									),
								),
							)
						return next(
							text === ""
								? input
								: {
										...input,
										instructions: Prompt.concat(
											input.instructions,
											Prompt.make([
												{
													role: "system",
													content:
														"Historical memory is evidence with a limited scope. Follow the current instructions.\n" +
														text,
												},
											]),
										),
									},
						).pipe(
							Stream.flatMap((event) =>
								generate &&
								event._tag === "TurnCompleted" &&
								event.turn.status._tag === "Completed"
									? Stream.concat(
											Stream.succeed(event),
											Stream.drain(Stream.fromEffect(consolidate(event))),
										)
									: Stream.succeed(event),
							),
						)
					}),
				),
			),
	)
}
