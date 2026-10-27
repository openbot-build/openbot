import { PgClient } from "@effect/sql-pg"
import { eq } from "drizzle-orm"
import {
	Array as Arr,
	Clock,
	type Duration,
	Effect,
	Option,
	PubSub,
	pipe,
	Stream,
} from "effect"
import * as Background from "../app/Background.ts"
import * as Failures from "../app/Failures.ts"
import * as Db from "../database/Database.ts"
import { computerCalls } from "../database/Schema.ts"
import { ComputerCallFailed } from "./Computer.ts"

/** A stored call that still waits for its reply. */
export interface Waiting {
	/** Who the call is for, such as a Computer ID. */
	readonly computerId: string
	/** The call as JSON text. */
	readonly call: string
}

/**
 * Calls between instances through the `openbot_computer_calls` table. One
 * instance stores a call and sends `call:<id>` on a Postgres channel. The
 * instance that can do the call stores its reply in the same row and sends
 * `reply:<id>`. The module that uses this listens on the channel itself, and
 * gives each reply notice to `replied`.
 */
export const make = (channel: string) =>
	Effect.gen(function* () {
		const db = yield* Db.make
		const client = yield* PgClient.PgClient
		const replies = yield* PubSub.unbounded<string>()
		yield* Effect.addFinalizer(() => PubSub.shutdown(replies))

		/** A storage step of the caller. Trying again may help. */
		const step = (log: string, message: string) =>
			Failures.replace(log, () =>
				ComputerCallFailed.make({ message, retry: true }),
			)
		const remove = (id: string) =>
			db
				.delete(computerCalls)
				.where(eq(computerCalls.id, id))
				.pipe(
					Background.logFailure("OpenBot could not remove a call", {
						level: "Debug",
					}),
				)

		/**
		 * Stores a call, tells the other instances, and waits up to `wait` for
		 * the reply. It gives the reply text, or none when no reply came in time.
		 * The row goes at the end, also when the caller stops waiting.
		 */
		const ask = (input: {
			readonly id: string
			readonly computerId: string
			readonly call: string
			readonly wait: Duration.Input
		}): Effect.Effect<Option.Option<string>, ComputerCallFailed> =>
			Effect.gen(function* () {
				// The subscription starts before the notice, so this cannot miss the reply.
				const subscription = yield* PubSub.subscribe(replies)
				const now = yield* Clock.currentTimeMillis
				yield* db
					.insert(computerCalls)
					.values({
						id: input.id,
						computerId: input.computerId,
						call: input.call,
						createdAt: now,
					})
					.pipe(
						step(
							"OpenBot could not store a call",
							"OpenBot could not store the call.",
						),
					)
				yield* client
					.notify(channel, `call:${input.id}`)
					.pipe(
						step(
							"OpenBot could not send a call",
							"OpenBot could not send the call.",
						),
					)
				const replied = yield* Stream.fromSubscription(subscription).pipe(
					Stream.filter((each) => each === input.id),
					Stream.runHead,
					Effect.timeoutOption(input.wait),
				)
				if (Option.isNone(replied)) return Option.none<string>()
				const rows = yield* db
					.select({ reply: computerCalls.reply })
					.from(computerCalls)
					.where(eq(computerCalls.id, input.id))
					.pipe(
						step(
							"OpenBot could not read the reply of a call",
							"OpenBot could not read the reply.",
						),
					)
				return Option.flatMapNullishOr(Arr.head(rows), (row) => row.reply)
			}).pipe(
				Effect.ensuring(remove(input.id)),
				Effect.scoped,
				Effect.annotateLogs({ channel }),
			)

		/** The call with this ID, when it still waits for a reply. */
		const row = (id: string) =>
			db
				.select()
				.from(computerCalls)
				.where(eq(computerCalls.id, id))
				.pipe(
					Effect.map((rows) =>
						pipe(
							Arr.head(rows),
							Option.filter((found) => found.reply === null),
							Option.map((found): Waiting => ({
								computerId: found.computerId,
								call: found.call,
							})),
						),
					),
				)

		/** Stores the reply of a call, and tells the instance that waits for it. */
		const answer = (id: string, reply: string) =>
			db
				.update(computerCalls)
				.set({ reply })
				.where(eq(computerCalls.id, id))
				.pipe(Effect.andThen(client.notify(channel, `reply:${id}`)))

		/** A reply notice came on the channel. */
		const replied = (id: string) =>
			PubSub.publish(replies, id).pipe(Effect.asVoid)

		return { ask, row, answer, replied } as const
	})
