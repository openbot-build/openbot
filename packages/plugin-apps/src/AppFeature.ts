import { Context, Effect, Layer, Scope } from "effect"
import * as WorkflowTools from "@openbot-build/apps-contract/apps/WorkflowTools"
import type { Gate } from "@openbot-build/conversation-contract/capabilities/Gate"
import {
	BotFeatures,
	wait,
} from "@openbot-build/conversation-contract/chats/BotFeatures"
import * as AppTools from "./AppTools.ts"

/** The id that Turn journals keep. Never change it. */
export const id = "@openbot-build/plugin-apps"

/**
 * Gives the App tools to every Turn until the scope closes. They are built
 * last, so an App tool never takes the name of another tool.
 */
export const contribute = Effect.gen(function* () {
	const features = yield* BotFeatures
	const workflows = yield* WorkflowTools.make
	// The layer scope must not reach a Turn: the phase scope owns its tools.
	const services = yield* Effect.context<
		Exclude<
			Effect.Services<ReturnType<typeof AppTools.durable>>,
			Gate | Scope.Scope
		>
	>().pipe(Effect.map(Context.omit(Scope.Scope)))
	yield* features.contribute({
		id,
		version: 1,
		order: 10,
		build: "last",
		review: false,
		restores: [],
		missing: wait(),
		settings: Effect.succeed(null),
		prepare: (fence) =>
			AppTools.durable(fence).pipe(
				Effect.provideContext(services),
				Effect.map((apps) => ({
					register: (input) => apps.register(input.owner, input.occupied),
				})),
			),
		restore: workflows.restore,
	})
})

export const layer = Layer.effectDiscard(contribute)
