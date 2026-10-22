import type { Session, Turn } from "@openbot-build/core"
import { Context, Data, Effect, Layer, PubSub } from "effect"

/** News that the coordinator acts on. Recovery after a restart covers news that got lost. */
export type Signal = Data.TaggedEnum<{
	/** The current Turn of a Session changed its status. */
	TurnChanged: {
		readonly organizationId: string
		readonly userId: string
		readonly session: Session.Id
		readonly turn: Turn.Id
		readonly status: Turn.Status["_tag"]
	}
	/** A tool call started to wait until a time. */
	WaitStarted: {
		readonly organizationId: string
		readonly wait: string
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
>()("@openbot-build/openbot/agents/Signals") {}

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

/** Publishes when the service is there. Code that runs without Agents does nothing. */
export const publish = (signal: Signal) =>
	Effect.serviceOption(Signals).pipe(
		Effect.flatMap((signals) =>
			signals._tag === "Some" ? signals.value.publish(signal) : Effect.void,
		),
	)
