import {
	type SessionResponseEvent,
	type SessionResponseSseEvent,
} from "@openbot-build/platform-api"
import { Effect, Stream, Cause, Deferred, Queue, Scope } from "effect"

type WithoutSequence<T> = T extends unknown ? Omit<T, "sequence_number"> : never

export type EventInput = WithoutSequence<SessionResponseEvent>
type WithoutContext<T> = T extends unknown
	? Omit<T, "session" | "turn" | "step">
	: never
export type Payload = WithoutContext<EventInput>

export interface Sink {
	readonly emit: (event: EventInput) => Effect.Effect<boolean>
	readonly finish: (events: ReadonlyArray<EventInput>) => Effect.Effect<boolean>
	readonly stream: Stream.Stream<SessionResponseSseEvent>
}

/** The observer owns the buffer. The Sessions scope owns the producer. */
export const make: Effect.Effect<Sink, never, Scope.Scope> = Effect.gen(
	function* () {
		const queue = yield* Queue.bounded<EventInput, Cause.Done>(64)
		const terminal = yield* Deferred.make<ReadonlyArray<EventInput>>()
		yield* Effect.addFinalizer(() => Queue.shutdown(queue))
		let sequence = 0
		const numbered = (event: EventInput): SessionResponseEvent => ({
			...event,
			sequence_number: sequence++,
		})
		return {
			emit: (event: EventInput) => Queue.offer(queue, event),
			// Finalizers must not wait for space in a full observer queue.
			finish: (events: ReadonlyArray<EventInput>) =>
				Deferred.succeed(terminal, events).pipe(
					Effect.andThen(Queue.end(queue)),
				),
			stream: Stream.concat(
				Stream.fromQueue(queue),
				Stream.fromEffect(Deferred.await(terminal)).pipe(
					Stream.flatMap(Stream.fromIterable),
				),
			).pipe(
				Stream.map((event): SessionResponseSseEvent => {
					const data = numbered(event)
					return { event: data.type, data }
				}),
				Stream.ensuring(Queue.shutdown(queue)),
			),
		}
	},
)
