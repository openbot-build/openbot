import { Context, Effect, Layer, Scope } from "effect"
import type { Gate } from "@openbot-build/conversation-contract/capabilities/Gate"
import {
	BotFeatures,
	wait,
} from "@openbot-build/conversation-contract/chats/BotFeatures"
import * as WorkTools from "./WorkTools.ts"

/** The id that Turn journals keep. Never change it. */
export const id = "@openbot-build/plugin-work"

/** Gives the work control tools to every Turn until the scope closes. */
export const contribute = Effect.gen(function* () {
	const features = yield* BotFeatures
	// The layer scope must not reach a Turn: the phase scope owns its tools.
	const services = yield* Effect.context<
		Exclude<
			Effect.Services<ReturnType<typeof WorkTools.durable>>,
			Gate | Scope.Scope
		>
	>().pipe(Effect.map(Context.omit(Scope.Scope)))
	yield* features.contribute({
		id,
		version: 1,
		order: 40,
		build: "normal",
		review: true,
		restores: [],
		missing: wait(),
		settings: Effect.succeed(null),
		prepare: (fence) =>
			WorkTools.durable(fence).pipe(
				Effect.provideContext(services),
				Effect.map((work) => ({
					register: (input) =>
						work.register({ read: input.read, store: input.store }),
				})),
			),
	})
})

export const layer = Layer.effectDiscard(contribute)
