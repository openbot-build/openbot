import { Context, Effect, Layer, Scope } from "effect"
import type { Gate } from "../conversation-contract/capabilities/Gate.ts"
import { BotFeatures } from "../conversation-contract/chats/BotFeatures.ts"
import * as BotTools from "./BotTools.ts"
import * as DelegationTools from "./WorkflowTools.ts"

/** The id that Turn journals keep. Never change it. */
export const id = "@openbot-build/plugin-bots"

/** Gives the Bot and delegation tools to every Turn until the scope closes. */
export const contribute = Effect.gen(function* () {
	const features = yield* BotFeatures
	const delegations = yield* DelegationTools.make
	// The layer scope must not reach a Turn: the phase scope owns its tools.
	const services = yield* Effect.context<
		Exclude<
			Effect.Services<ReturnType<typeof BotTools.durable>>,
			Gate | Scope.Scope
		>
	>().pipe(Effect.map(Context.omit(Scope.Scope)))
	yield* features.contribute({
		id,
		version: 1,
		order: 20,
		build: "normal",
		review: true,
		restores: [],
		settings: Effect.succeed(null),
		prepare: (fence) =>
			BotTools.durable(fence).pipe(
				Effect.provideContext(services),
				Effect.map((bots) => ({
					register: (input) =>
						bots.register({
							owner: input.owner,
							namespace: input.namespace,
							read: input.read,
							items: input.items,
						}),
				})),
			),
		restore: delegations.restore,
	})
})

export const layer = Layer.effectDiscard(contribute)
