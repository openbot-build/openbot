import { Context, Effect, Layer, Scope } from "effect"
import type { Gate } from "../conversation-contract/capabilities/Gate.ts"
import { BotFeatures } from "../conversation-contract/chats/BotFeatures.ts"
import * as ChannelTools from "./ChannelTools.ts"

/** The id that Turn journals keep. Never change it. */
export const id = "@openbot-build/plugin-channels"

/** Gives the Channel tools to every Turn that is not a review, until the scope closes. */
export const contribute = Effect.gen(function* () {
	const features = yield* BotFeatures
	// The layer scope must not reach a Turn: the phase scope owns its tools.
	const services = yield* Effect.context<
		Exclude<
			Effect.Services<ReturnType<typeof ChannelTools.durable>>,
			Gate | Scope.Scope
		>
	>().pipe(Effect.map(Context.omit(Scope.Scope)))
	yield* features.contribute({
		id,
		version: 1,
		order: 50,
		build: "normal",
		review: false,
		restores: [],
		settings: Effect.succeed(null),
		prepare: (fence) =>
			ChannelTools.durable(fence).pipe(
				Effect.provideContext(services),
				Effect.map((channels) => ({
					register: (input) => channels.register({ read: input.read }),
				})),
			),
	})
})

export const layer = Layer.effectDiscard(contribute)
