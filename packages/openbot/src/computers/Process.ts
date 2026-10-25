import { type Cause, Deferred, Effect, Queue, Stream } from "effect"
import type { Exit } from "./Computer.ts"

/**
 * The output and the end of a command, filled by a provider as messages come.
 * `end` closes the output, so a reader sees all the output before the exit.
 */
export const make = Effect.gen(function* () {
	const queue = yield* Queue.unbounded<Uint8Array, Cause.Done>()
	const exited = yield* Deferred.make<Exit>()
	return {
		push: (bytes: Uint8Array) =>
			bytes.length === 0
				? Effect.void
				: Effect.asVoid(Queue.offer(queue, bytes)),
		end: (exit: Exit) =>
			Deferred.succeed(exited, exit).pipe(
				Effect.andThen(Queue.end(queue)),
				Effect.asVoid,
			),
		output: Stream.fromQueue(queue),
		exit: Deferred.await(exited),
		ended: Deferred.isDone(exited),
	}
})
export type Sink = Effect.Success<typeof make>
