import { Execution } from "@openbot-build/domain"
import { and, eq } from "drizzle-orm"
import { Array as Arr, Effect, Option } from "effect"
import { ChannelEvent } from "../../src/channels/Channel.ts"
import { ChannelQueue } from "../../src/channels/ChannelQueue.ts"
import { Channels } from "../../src/channels/Channels.ts"
import * as Db from "../../src/database/Database.ts"
import { executions } from "../../src/database/Schema.ts"
import { Store } from "../../src/execution/Store.ts"

/** Reads the saved caller after a Channel is made through the API. */
export const authority = (organizationId: string, channelId: string) =>
	Effect.flatMap(Channels, (channels) =>
		channels.authority(organizationId, channelId).pipe(
			Effect.flatMap(
				Option.match({
					onNone: () => Effect.die("The Channel has no caller."),
					onSome: Effect.succeed,
				}),
			),
		),
	)

/** Reads saved attempts so a restart cannot hide a second outside call. */
export const calls = (organizationId: string, id: Execution.Id) =>
	Effect.gen(function* () {
		const store = yield* Store
		return yield* store.calls(yield* store.locate(id, organizationId))
	})

/** Reads the saved decision which the user can answer through the API. */
export const events = (organizationId: string, id: Execution.Id) =>
	Effect.gen(function* () {
		const store = yield* Store
		return yield* store.events(yield* store.locate(id, organizationId), 0)
	})

/** Reads the owner version to wait for recovery after a server restart. */
export const generation = (organizationId: string, id: Execution.Id) =>
	Effect.gen(function* () {
		const store = yield* Store
		return (yield* store.load(yield* store.locate(id, organizationId)))
			.generation
	})

/** Plays one incoming message after the provider has checked it. */
export const receiveMessage = (
	organizationId: string,
	channelId: string,
	message: {
		readonly eventId: string
		readonly conversation: {
			readonly key: string
			readonly kind: "direct" | "group"
		}
		readonly sender: {
			readonly externalId: string
			readonly displayName: string
		}
		readonly text: string
		readonly mentioned: boolean
	},
) =>
	Effect.flatMap(ChannelQueue, (queue) =>
		queue.receive(organizationId, channelId, [ChannelEvent.Message(message)]),
	)

/** Reads one delivery while its outside reply is unknown. */
export const delivery = (organizationId: string) =>
	Effect.gen(function* () {
		const db = yield* Db.make
		return Arr.head(
			yield* db
				.select({
					namespace: executions.namespace,
					id: executions.id,
					generation: executions.generation,
					status: executions.status,
				})
				.from(executions)
				.where(
					and(
						eq(executions.organizationId, organizationId),
						eq(executions.resourceKind, "ChannelDelivery"),
					),
				),
		)
	})
