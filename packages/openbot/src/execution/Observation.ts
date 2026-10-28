import { Execution } from "@openbot-build/domain"
import { PgClient } from "@effect/sql-pg"
import {
	Array as Arr,
	Context,
	Data,
	Effect,
	Layer,
	Option,
	PubSub,
	RcMap,
	Ref,
	Schedule,
	Stream,
} from "effect"
import * as Background from "./Background.ts"
import { Store, type Key } from "./Store.ts"

class EventKey extends Data.Class<Key> {}
const ended = (event: Execution.Event): boolean =>
	event.body._tag === "State" && Execution.isTerminal(event.body.status)

export interface Service {
	readonly observe: (
		key: Key,
		afterSequence: number,
	) => Stream.Stream<
		| Execution.Event
		| {
				executionId: Execution.Id
				sequence: number
				createdAt: number
				body: Execution.EventBody
		  },
		Execution.NotFound | Execution.StorageError
	>
}

export class Observation extends Context.Service<Observation, Service>()(
	"@openbot-build/openbot/execution/Observation",
) {}

const make = Effect.gen(function* () {
	const background = yield* Background.make
	const store = yield* Store
	const client = yield* PgClient.PgClient
	const wake = yield* PubSub.sliding<void>(1)
	// A lost notification cannot lose an event. One timer wakes this node's readers.
	yield* background.repeat(PubSub.publish(wake, undefined), {
		schedule: Schedule.spaced("1 second"),
		message: "Execution readers could not be woken.",
	})
	yield* background.repeat(
		Effect.scoped(
			client
				.listen("openbot_execution_events")
				.pipe(
					Effect.flatMap((queue) =>
						Stream.fromQueue(queue).pipe(
							Stream.runForEach(() => PubSub.publish(wake, undefined)),
						),
					),
				),
		),
		{
			schedule: Schedule.spaced("1 second"),
			message: "Execution event notices were lost.",
		},
	)
	/** One reader per active execution on this node. Slow readers use their cursor. */
	const readers = yield* RcMap.make({
		lookup: Effect.fn("ExecutionObservation.reader")(function* (key: EventKey) {
			const state = yield* store.get(key)
			const bus = yield* PubSub.sliding<Execution.Event>(128)
			const sequence = yield* Ref.make(state.sequence)
			const notices = yield* PubSub.subscribe(wake)
			const read = Effect.gen(function* () {
				const cursor = yield* Ref.get(sequence)
				const batch = yield* store.events(key, cursor)
				yield* Effect.forEach(batch, (event) => PubSub.publish(bus, event), {
					discard: true,
				})
				if (Arr.isReadonlyArrayNonEmpty(batch))
					yield* Ref.set(sequence, Arr.lastNonEmpty(batch).sequence)
				return batch.length
			})
			yield* Stream.fromSubscription(notices).pipe(
				Stream.runForEach(() =>
					read.pipe(
						Effect.repeat({ until: (count) => count < 128 }),
						background.logFailure("Execution events could not be read."),
					),
				),
				Effect.forkScoped,
			)
			return bus
		}),
		idleTimeToLive: "0 millis",
	})
	const observe = (key: Key, afterSequence: number) =>
		Stream.unwrap(
			Effect.gen(function* () {
				const bus = yield* RcMap.get(readers, new EventKey(key))
				const queue = yield* PubSub.subscribe(bus)
				const cursor = yield* Ref.make(afterSequence)
				const read = Stream.paginate(
					afterSequence,
					Effect.fn(function* (after) {
						const batch = yield* store.events(key, after)
						return [
							batch,
							Arr.isReadonlyArrayNonEmpty(batch) && batch.length === 128
								? Option.some(Arr.lastNonEmpty(batch).sequence)
								: Option.none(),
						]
					}),
				)
				const state = yield* store.get(key)
				if (
					Execution.isTerminal(state.status) &&
					afterSequence >= state.sequence
				)
					return Stream.empty
				const live = Stream.fromSubscription(queue).pipe(
					Stream.flatMap((event) =>
						Stream.unwrap(
							Effect.gen(function* () {
								const after = yield* Ref.get(cursor)
								if (event.sequence <= after) return Stream.empty
								if (event.sequence === after + 1) return Stream.succeed(event)
								return Stream.paginate(
									after,
									Effect.fn(function* (position) {
										const batch = yield* store.events(key, position)
										return [
											batch,
											Arr.isReadonlyArrayNonEmpty(batch) &&
											Arr.lastNonEmpty(batch).sequence < event.sequence
												? Option.some(Arr.lastNonEmpty(batch).sequence)
												: Option.none(),
										]
									}),
								)
							}),
						),
					),
				)
				return Stream.concat(read, live).pipe(
					Stream.tap((event) => Ref.set(cursor, event.sequence)),
					Stream.takeUntil(ended),
				)
			}),
		)
	return Observation.of({ observe })
})

export const layer = Layer.effect(Observation, make)
