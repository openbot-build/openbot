import {
	type ChatResponseEvent,
	type ChatResponseSseEvent,
} from "@openbot-build/api"
import { Effect, Stream, Cause, Deferred, Queue, Scope } from "effect"

type WithoutSequence<T> = T extends unknown ? Omit<T, "sequence_number"> : never

export type EventInput = WithoutSequence<ChatResponseEvent>
type WithoutContext<T> = T extends unknown
	? Omit<T, "chat" | "turn" | "step">
	: never
export type Payload = WithoutContext<EventInput>

export interface Sink {
	readonly emit: (event: EventInput) => Effect.Effect<boolean>
	readonly finish: (events: ReadonlyArray<EventInput>) => Effect.Effect<boolean>
	readonly stream: Stream.Stream<ChatResponseSseEvent>
}

/** The scope of the observer owns the buffer and the producer. */
export const make: Effect.Effect<Sink, never, Scope.Scope> = Effect.gen(
	function* () {
		const queue = yield* Queue.bounded<EventInput, Cause.Done>(64)
		const terminal = yield* Deferred.make<ReadonlyArray<EventInput>>()
		yield* Effect.addFinalizer(() => Queue.shutdown(queue))
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
				Stream.map((event, index): ChatResponseSseEvent => {
					const data: ChatResponseEvent = { ...event, sequence_number: index }
					return { event: data.type, data }
				}),
				Stream.ensuring(Queue.shutdown(queue)),
			),
		}
	},
)
