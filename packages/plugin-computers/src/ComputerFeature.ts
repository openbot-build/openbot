import { Context, Effect, Layer, Record as Rec, Scope } from "effect"
import type { Gate } from "@openbot-build/conversation-contract/capabilities/Gate"
import { BotFeatures } from "@openbot-build/conversation-contract/chats/BotFeatures"
import * as ComputerTools from "./ComputerTools.ts"

/** The id that Turn journals keep. Never change it. */
export const id = "@openbot-build/plugin-computers"

/**
 * Gives the Computer tools to every Turn that is not a review, until the
 * scope closes. A saved Computer tool call comes back by its name.
 */
export const contribute = Effect.gen(function* () {
	const features = yield* BotFeatures
	// The layer scope must not reach a Turn: the phase scope owns its tools.
	const services = yield* Effect.context<
		Exclude<Effect.Services<typeof ComputerTools.make>, Gate | Scope.Scope>
	>().pipe(Effect.map(Context.omit(Scope.Scope)))
	yield* features.contribute({
		id,
		version: 1,
		order: 60,
		build: "normal",
		review: false,
		restores: Rec.values(ComputerTools.names),
		settings: Effect.succeed(null),
		prepare: () =>
			ComputerTools.make.pipe(
				Effect.provideContext(services),
				Effect.map((computers) => ({
					register: (input) => computers.register({ notify: input.notify }),
					restoreTool: (input, name, work) =>
						computers.restore(input, name, work),
				})),
			),
	})
})

export const layer = Layer.effectDiscard(contribute)
