import type { Chat, Turn } from "@openbot-build/core"
import { Context, Data, Effect, Layer, PubSub } from "effect"

/** News that the coordinator acts on. Recovery and the sweep cover news that got lost. */
export type Signal = Data.TaggedEnum<{
	/** The current Turn of a Chat changed. */
	TurnChanged: {
		readonly organizationId: string
		readonly userId: string
		readonly chat: Chat.Id
		readonly turn: Turn.Id
		readonly status: Turn.Status["_tag"]
	}
	/** A delegation was made, or it may start now. */
	DelegationChanged: {
		readonly organizationId: string
		readonly delegation: string
	}
	/** The Bot that gave a delegation stops it. Its own Chat gets no message about it. */
	DelegationCancelled: {
		readonly organizationId: string
		readonly delegation: string
		readonly reason: string
	}
	/** A reminder was set for a time. */
	ReminderStarted: {
		readonly organizationId: string
		readonly reminder: string
	}
	/** A request was made, decided or passed up. */
	RequestChanged: {
		readonly organizationId: string
		readonly request: string
	}
}>
export const Signal = Data.taggedEnum<Signal>()

export class Signals extends Context.Service<
	Signals,
	{
		readonly publish: (signal: Signal) => Effect.Effect<void>
		readonly pubsub: PubSub.PubSub<Signal>
	}
>()("@openbot-build/openbot/bots/Signals") {}

export const layer = Layer.effect(
	Signals,
	Effect.gen(function* () {
		const pubsub = yield* PubSub.unbounded<Signal>()
		yield* Effect.addFinalizer(() => PubSub.shutdown(pubsub))
		return Signals.of({
			pubsub,
			publish: (signal) => PubSub.publish(pubsub, signal).pipe(Effect.asVoid),
		})
	}),
)

/** Publishes when the service is there. Code that runs without Bots does nothing. */
export const publish = (signal: Signal) =>
	Effect.serviceOption(Signals).pipe(
		Effect.flatMap((signals) =>
			signals._tag === "Some" ? signals.value.publish(signal) : Effect.void,
		),
	)
