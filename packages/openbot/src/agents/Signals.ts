import * as ExecutionFence from "../execution/ExecutionFence.ts"
import * as InstanceWork from "../execution/InstanceWork.ts"
import type { Session, Turn } from "@openbot-build/core"
import { Context, Data, Effect, Exit, Layer, Queue, Scope } from "effect"

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
	/** A request was made, decided or passed up. */
	RequestChanged: {
		readonly organizationId: string
		readonly request: string
	}
}>
export const Signal = Data.taggedEnum<Signal>()

export interface Envelope {
	readonly signal: Signal
	readonly execution: ExecutionFence.Lease | undefined
	readonly reservation: InstanceWork.Reservation
	readonly release: Effect.Effect<void>
}

export class Signals extends Context.Service<
	Signals,
	{
		readonly publish: (signal: Signal) => Effect.Effect<void>
		readonly queue: Queue.Queue<Envelope>
	}
>()("@openbot-build/openbot/agents/Signals") {}

export const layer = Layer.effect(
	Signals,
	Effect.gen(function* () {
		const queue = yield* Queue.unbounded<Envelope>()
		yield* Effect.addFinalizer(() =>
			Queue.clear(queue).pipe(
				Effect.flatMap((pending) =>
					Effect.forEach(pending, (entry) => entry.release),
				),
				Effect.andThen(Queue.shutdown(queue)),
			),
		)
		return Signals.of({
			queue,
			publish: (signal) =>
				Effect.gen(function* () {
					const execution = yield* ExecutionFence.CurrentExecution
					const reservation = yield* InstanceWork.reserve
					const scope = yield* Scope.make()
					const release = Scope.close(scope, Exit.void).pipe(
						Effect.ensuring(reservation.release),
					)
					// The queued continuation still belongs to the admitted epoch. Its
					// durable account lease stays alive until the consumer really finishes.
					yield* (
						execution === undefined
							? Effect.void
							: ExecutionFence.guardScoped(
									execution.accountId,
									"continue",
									Effect.void,
								).pipe(Effect.provideService(Scope.Scope, scope))
					).pipe(
						Effect.onExit((exit) =>
							exit._tag === "Failure" ? release : Effect.void,
						),
					)
					const accepted = yield* Queue.offer(queue, {
						signal,
						execution,
						reservation,
						release,
					}).pipe(
						Effect.onExit((exit) =>
							exit._tag === "Failure" ? release : Effect.void,
						),
					)
					if (!accepted) yield* release
				}).pipe(Effect.uninterruptible, Effect.orDie),
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
