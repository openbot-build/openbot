import { Context, Effect, Layer, Scope } from "effect"
import type { Gate } from "@openbot-build/conversation-contract/capabilities/Gate"
import {
	BotFeatures,
	wait,
} from "@openbot-build/conversation-contract/chats/BotFeatures"
import * as ArtifactTools from "./ArtifactTools.ts"

/** The id that Turn journals keep. Never change it. */
export const id = "@openbot-build/plugin-artifacts"

/** Gives the artifact tools to every Turn until the scope closes. */
export const contribute = Effect.gen(function* () {
	const features = yield* BotFeatures
	// The layer scope must not reach a Turn: the phase scope owns its tools.
	const services = yield* Effect.context<
		Exclude<
			Effect.Services<ReturnType<typeof ArtifactTools.durable>>,
			Gate | Scope.Scope
		>
	>().pipe(Effect.map(Context.omit(Scope.Scope)))
	yield* features.contribute({
		id,
		version: 1,
		order: 70,
		build: "normal",
		review: false,
		restores: [],
		missing: wait(),
		settings: Effect.succeed(null),
		prepare: (fence) =>
			ArtifactTools.durable(fence).pipe(
				Effect.provideContext(services),
				Effect.map((work) => ({
					register: (input) => work.register({ read: input.read }),
				})),
			),
	})
})

export const layer = Layer.effectDiscard(contribute)
