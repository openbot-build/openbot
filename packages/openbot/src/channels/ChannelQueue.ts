import { ChannelsApi } from "@openbot-build/api"
import { Chat, Turn } from "@openbot-build/core"
import { and, asc, eq, lt, lte, or, sql } from "drizzle-orm"
import {
	Array as Arr,
	Cause,
	Clock,
	Context,
	Crypto,
	Effect,
	Layer,
	Option,
	Schema,
} from "effect"
import * as Failures from "../app/Failures.ts"
import { channelDeliveries, channelInbox } from "../database/Schema.ts"
import {
	type ChannelEvent,
	ChannelEventSchema,
	MessageRef,
	OutboundMessage,
	type Target,
	TargetSchema,
} from "./Channel.ts"
import * as Db from "../database/Database.ts"

/**
 * How long a worker holds a claimed item before another worker may take it. A worker
 * renews the lease while it still works on the item.
 */
export const leaseMs = 60_000
/** After this many failed tries, OpenBot gives up on an item and logs it. */
export const maxAttempts = 6

/** The wait before the next try: 2, 4, 8 ... seconds, at most 5 minutes. */
export const backoffMs = (attempts: number) =>
	Math.min(2 ** attempts * 1000, 5 * 60 * 1000)

export interface ClaimedEvent {
	readonly organizationId: string
	readonly channelId: string
	readonly event: ChannelEvent
	readonly attempts: number
	readonly claim: string
}

/** The queue writes these columns as JSON, so it reads them back with the same schemas. */
const TargetJson = Schema.fromJsonString(TargetSchema)
const MessageJson = Schema.fromJsonString(OutboundMessage)
const RefJson = Schema.fromJsonString(MessageRef)
const EventJson = Schema.fromJsonString(ChannelEventSchema)
const decodeTarget = Schema.decodeUnknownEffect(TargetJson)
const decodeMessage = Schema.decodeUnknownEffect(MessageJson)
const decodeRef = Schema.decodeUnknownEffect(RefJson)
const decodeEvent = Schema.decodeUnknownEffect(EventJson)
// The types already check these values, so a failure to encode them is a defect.
const encodeTarget = (target: Target) =>
	Effect.orDie(Schema.encodeEffect(TargetJson)(target))
const encodeMessage = (message: OutboundMessage) =>
	Effect.orDie(Schema.encodeEffect(MessageJson)(message))
const encodeRef = (ref: MessageRef) =>
	Effect.orDie(Schema.encodeEffect(RefJson)(ref))
const encodeEvent = (event: ChannelEvent) =>
	Effect.orDie(Schema.encodeEffect(EventJson)(event))

export interface Delivery {
	readonly id: string
	readonly organizationId: string
	readonly channelId: string
	readonly target: Target
	readonly message: OutboundMessage
	readonly ref: MessageRef | null
	readonly attempts: number
	readonly claim: string
	/** When the worker took it. A newer body than this must go out again. */
	readonly claimedAt: number
}

type Failure = ChannelsApi.ChannelsUnavailable

/**
 * The work of the Channels in the database, so it survives a restart and many instances
 * share it: the events that wait to be handled, and the messages that wait to go out.
 */
export class ChannelQueue extends Context.Service<
	ChannelQueue,
	{
		/** Keeps new events. An event that is already there is dropped. */
		readonly receive: (
			organizationId: string,
			channelId: string,
			events: ReadonlyArray<ChannelEvent>,
		) => Effect.Effect<void, Failure>
		/**
		 * Takes the oldest open event of each chat, so each chat keeps its order. A stored
		 * event that does not decode is logged and dropped, so it does not stop the others.
		 */
		readonly claimEvents: Effect.Effect<ReadonlyArray<ClaimedEvent>, Failure>
		readonly finishEvent: (event: ClaimedEvent) => Effect.Effect<void, Failure>
		/**
		 * Tries the event again later. After too many tries, it ends. The result is true
		 * when OpenBot gave up on the event.
		 */
		readonly retryEvent: (
			event: ClaimedEvent,
		) => Effect.Effect<boolean, Failure>
		/**
		 * Puts an event back at once, and it does not count as a try. This is for an
		 * event whose work was stopped, such as at shut down.
		 */
		readonly releaseEvent: (event: ClaimedEvent) => Effect.Effect<void, Failure>
		/**
		 * Gives the claimed events a new lease, so no other worker takes them while this
		 * worker still works on them. An event that is done or put back stays as it is.
		 */
		readonly extendEvents: (
			events: ReadonlyArray<ClaimedEvent>,
		) => Effect.Effect<void, Failure>
		/** A message that goes out once, such as a link prompt. */
		readonly notice: (input: {
			readonly organizationId: string
			readonly channelId: string
			readonly target: Target
			readonly message: OutboundMessage
		}) => Effect.Effect<void, Failure>
		/** Remembers the message that shows a Turn while it runs. */
		readonly startReply: (input: {
			readonly organizationId: string
			readonly channelId: string
			readonly target: Target
			readonly chat: Chat.Id
			readonly turn: Turn.Id
			readonly ref: MessageRef | null
		}) => Effect.Effect<void, Failure>
		/** The final answer of a Turn. It changes the running message, or sends a new one. */
		readonly finishReply: (input: {
			readonly organizationId: string
			readonly channelId: string
			readonly target: Target
			readonly chat: Chat.Id
			readonly turn: Turn.Id
			readonly message: OutboundMessage
		}) => Effect.Effect<void, Failure>
		/** The card of a request. A later change of the request changes the same card. */
		readonly putRequest: (input: {
			readonly organizationId: string
			readonly channelId: string
			readonly target: Target
			readonly request: string
			readonly message: OutboundMessage
		}) => Effect.Effect<void, Failure>
		/** The message of a request card, when it went out. */
		readonly requestRef: (
			channelId: string,
			request: string,
		) => Effect.Effect<MessageRef | null, Failure>
		/**
		 * Takes the messages that are due. A stored message that does not decode is
		 * logged and marked as failed, so it does not stop the others.
		 */
		readonly claimDeliveries: Effect.Effect<ReadonlyArray<Delivery>, Failure>
		readonly finishDelivery: (
			delivery: Delivery,
			ref: MessageRef,
		) => Effect.Effect<void, Failure>
		/**
		 * Tries the message again later. It gives up on the message when `give` is true,
		 * or after too many tries. The result is true when OpenBot gave up on it.
		 */
		readonly retryDelivery: (
			delivery: Delivery,
			delayMs: number | undefined,
			give: boolean,
		) => Effect.Effect<boolean, Failure>
		/**
		 * Gives the claimed messages a new lease, so no other worker sends them while
		 * this worker still sends them. A message that is done or put back stays as it is.
		 */
		readonly extendDeliveries: (
			deliveries: ReadonlyArray<Delivery>,
		) => Effect.Effect<void, Failure>
		/** The replies of Turns that have not ended yet, to check them after a restart. */
		readonly liveReplies: Effect.Effect<
			ReadonlyArray<{
				readonly organizationId: string
				readonly channelId: string
				readonly target: Target
				readonly chat: Chat.Id
				readonly turn: Turn.Id
			}>,
			Failure
		>
		/**
		 * Ends the reply of a Turn that can never get its answer, such as when its Chat is
		 * gone. A reply that is no longer live stays as it is.
		 */
		readonly endReply: (reply: {
			readonly chat: Chat.Id
			readonly turn: Turn.Id
		}) => Effect.Effect<void, Failure>
	}
>()("@openbot-build/openbot/channels/ChannelQueue") {}

type DeliveryRow = typeof channelDeliveries.$inferSelect

const deliveryOf = (
	row: DeliveryRow,
	claim: string,
	claimedAt: number,
): Effect.Effect<Delivery, Schema.SchemaError> =>
	Effect.gen(function* () {
		return {
			id: row.id,
			organizationId: row.organizationId,
			channelId: row.channelId,
			target: yield* decodeTarget(row.target),
			message: yield* decodeMessage(row.body),
			ref: row.ref === null ? null : yield* decodeRef(row.ref),
			attempts: row.attempts,
			claim,
			claimedAt,
		}
	})

export const make = Effect.gen(function* () {
	const db = yield* Db.make
	const crypto = yield* Crypto.Crypto
	const newId = crypto.randomUUIDv4().pipe(Effect.orDie)
	/**
	 * A failure of the database, or a stored value that does not decode, is
	 * `ChannelsUnavailable`. The log keeps the cause.
	 */
	const stored = Failures.replace(
		"The Channel queue could not read or write its data.",
		() => ChannelsApi.ChannelsUnavailable.make({}),
	)
	const eventWhere = (event: ClaimedEvent) =>
		and(
			eq(channelInbox.channelId, event.channelId),
			eq(channelInbox.eventId, event.event.eventId),
			eq(channelInbox.claim, event.claim),
		)
	const deliveryWhere = (delivery: Delivery) =>
		and(
			eq(channelDeliveries.id, delivery.id),
			eq(channelDeliveries.claim, delivery.claim),
		)
	return ChannelQueue.of({
		receive: (organizationId, channelId, events) =>
			stored(
				Effect.gen(function* () {
					if (events.length === 0) return
					const now = yield* Clock.currentTimeMillis
					const rows = yield* Effect.forEach(events, (event, index) =>
						Effect.map(encodeEvent(event), (encoded) => ({
							organizationId,
							channelId,
							eventId: event.eventId,
							conversationKey: event.conversation.key,
							event: encoded,
							// Events of one request keep their order.
							receivedAt: now + index,
							nextAt: now,
						})),
					)
					yield* db.insert(channelInbox).values(rows).onConflictDoNothing()
				}),
			),
		claimEvents: stored(
			db.transaction((tx) =>
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis
					const claim = yield* newId
					const rows = yield* tx
						.select()
						.from(channelInbox)
						.where(
							and(
								sql`${channelInbox.doneAt} IS NULL`,
								lt(channelInbox.leaseUntil, now),
								lte(channelInbox.nextAt, now),
								// An older open event of the same chat goes first.
								sql`NOT EXISTS (SELECT 1 FROM ${channelInbox} AS older WHERE older.channel_id = ${channelInbox.channelId} AND older.conversation_key = ${channelInbox.conversationKey} AND older.done_at IS NULL AND (older.received_at, older.event_id) < (${channelInbox.receivedAt}, ${channelInbox.eventId}))`,
							),
						)
						.orderBy(asc(channelInbox.receivedAt))
						.limit(20)
						.for("update", { skipLocked: true })
					const claimed = yield* Effect.forEach(rows, (row) => {
						const where = and(
							eq(channelInbox.channelId, row.channelId),
							eq(channelInbox.eventId, row.eventId),
						)
						return decodeEvent(row.event).pipe(
							Effect.matchEffect({
								onSuccess: (event) =>
									tx
										.update(channelInbox)
										.set({ claim, leaseUntil: now + leaseMs })
										.where(where)
										.pipe(
											Effect.as(
												Option.some<ClaimedEvent>({
													organizationId: row.organizationId,
													channelId: row.channelId,
													event,
													attempts: row.attempts,
													claim,
												}),
											),
										),
								// No later try can read the event, and it would stop its chat.
								// So it ends here, and the next events of its chat can go.
								onFailure: (error) =>
									Effect.logError(
										"A stored Channel event does not decode. OpenBot drops it.",
										Cause.fail(error),
									).pipe(
										Effect.annotateLogs({
											channel: row.channelId,
											event: row.eventId,
										}),
										Effect.andThen(
											tx
												.update(channelInbox)
												.set({ doneAt: now, claim: null, leaseUntil: 0 })
												.where(where),
										),
										Effect.as(Option.none<ClaimedEvent>()),
									),
							}),
						)
					})
					return Arr.getSomes(claimed)
				}),
			),
		),
		finishEvent: (event) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				yield* stored(
					db
						.update(channelInbox)
						.set({ doneAt: now, claim: null, leaseUntil: 0 })
						.where(eventWhere(event)),
				)
			}),
		retryEvent: (event) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				const attempts = event.attempts + 1
				const gaveUp = attempts >= maxAttempts
				yield* stored(
					db
						.update(channelInbox)
						.set({
							attempts,
							claim: null,
							leaseUntil: 0,
							nextAt: now + backoffMs(attempts),
							...(gaveUp ? { doneAt: now } : {}),
						})
						.where(eventWhere(event)),
				)
				return gaveUp
			}),
		releaseEvent: (event) =>
			stored(
				db
					.update(channelInbox)
					.set({ claim: null, leaseUntil: 0 })
					.where(eventWhere(event)),
			),
		extendEvents: (events) =>
			Effect.gen(function* () {
				// Without a condition, the update would change every row.
				if (!Arr.isArrayNonEmpty(events)) return
				const now = yield* Clock.currentTimeMillis
				yield* stored(
					db
						.update(channelInbox)
						.set({ leaseUntil: now + leaseMs })
						.where(or(...Arr.map(events, eventWhere))),
				)
			}),
		notice: (input) =>
			stored(
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis
					yield* db.insert(channelDeliveries).values({
						id: yield* newId,
						organizationId: input.organizationId,
						channelId: input.channelId,
						kind: "notice",
						target: yield* encodeTarget(input.target),
						body: yield* encodeMessage(input.message),
						state: "pending",
						nextAt: now,
						updatedAt: now,
					})
				}),
			),
		startReply: (input) =>
			stored(
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis
					yield* db
						.insert(channelDeliveries)
						.values({
							id: yield* newId,
							organizationId: input.organizationId,
							channelId: input.channelId,
							kind: "reply",
							target: yield* encodeTarget(input.target),
							chat: input.chat,
							turn: input.turn,
							body: yield* encodeMessage({ markdown: "" }),
							ref: input.ref === null ? null : yield* encodeRef(input.ref),
							state: "live",
							nextAt: now,
							updatedAt: now,
						})
						.onConflictDoNothing()
				}),
			),
		finishReply: (input) =>
			stored(
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis
					const body = yield* encodeMessage(input.message)
					yield* db
						.insert(channelDeliveries)
						.values({
							id: yield* newId,
							organizationId: input.organizationId,
							channelId: input.channelId,
							kind: "reply",
							target: yield* encodeTarget(input.target),
							chat: input.chat,
							turn: input.turn,
							body,
							state: "pending",
							nextAt: now,
							updatedAt: now,
						})
						.onConflictDoUpdate({
							target: [channelDeliveries.chat, channelDeliveries.turn],
							set: {
								body,
								state: "pending",
								nextAt: now,
								updatedAt: now,
							},
							// A reply that already went out stays as it is.
							setWhere: sql`${channelDeliveries.state} = 'live'`,
						})
				}),
			),
		putRequest: (input) =>
			stored(
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis
					const body = yield* encodeMessage(input.message)
					yield* db
						.insert(channelDeliveries)
						.values({
							id: yield* newId,
							organizationId: input.organizationId,
							channelId: input.channelId,
							kind: "request",
							target: yield* encodeTarget(input.target),
							request: input.request,
							body,
							state: "pending",
							nextAt: now,
							updatedAt: now,
						})
						.onConflictDoUpdate({
							target: [channelDeliveries.channelId, channelDeliveries.request],
							set: {
								body,
								state: "pending",
								attempts: 0,
								nextAt: now,
								updatedAt: now,
							},
						})
				}),
			),
		requestRef: (channelId, request) =>
			stored(
				Effect.gen(function* () {
					const rows = yield* db
						.select({ ref: channelDeliveries.ref })
						.from(channelDeliveries)
						.where(
							and(
								eq(channelDeliveries.channelId, channelId),
								eq(channelDeliveries.request, request),
							),
						)
					const ref = rows[0]?.ref
					return ref === undefined || ref === null
						? null
						: yield* decodeRef(ref)
				}),
			),
		claimDeliveries: stored(
			db.transaction((tx) =>
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis
					const claim = yield* newId
					const rows = yield* tx
						.select()
						.from(channelDeliveries)
						.where(
							and(
								eq(channelDeliveries.state, "pending"),
								lte(channelDeliveries.nextAt, now),
								lt(channelDeliveries.leaseUntil, now),
							),
						)
						.orderBy(asc(channelDeliveries.nextAt))
						.limit(20)
						.for("update", { skipLocked: true })
					const claimed = yield* Effect.forEach(rows, (row) =>
						deliveryOf(row, claim, now).pipe(
							Effect.matchEffect({
								onSuccess: (delivery) =>
									tx
										.update(channelDeliveries)
										.set({ claim, leaseUntil: now + leaseMs })
										.where(eq(channelDeliveries.id, row.id))
										.pipe(Effect.as(Option.some(delivery))),
								// No later try can read the message, so it fails for good.
								onFailure: (error) =>
									Effect.logError(
										"A stored Channel message does not decode. OpenBot gives up on it.",
										Cause.fail(error),
									).pipe(
										Effect.annotateLogs({
											channel: row.channelId,
											delivery: row.id,
										}),
										Effect.andThen(
											tx
												.update(channelDeliveries)
												.set({ state: "failed", claim: null, leaseUntil: 0 })
												.where(eq(channelDeliveries.id, row.id)),
										),
										Effect.as(Option.none<Delivery>()),
									),
							}),
						),
					)
					return Arr.getSomes(claimed)
				}),
			),
		),
		finishDelivery: (delivery, ref) =>
			stored(
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis
					yield* db
						.update(channelDeliveries)
						.set({
							ref: yield* encodeRef(ref),
							claim: null,
							leaseUntil: 0,
							updatedAt: now,
							// A newer body that came while it was sent goes out again.
							state: sql`CASE WHEN ${channelDeliveries.updatedAt} > ${delivery.claimedAt} THEN 'pending' ELSE 'done' END`,
						})
						.where(deliveryWhere(delivery))
				}),
			),
		retryDelivery: (delivery, delayMs, give) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				const attempts = delivery.attempts + 1
				const gaveUp = give || attempts >= maxAttempts
				yield* stored(
					db
						.update(channelDeliveries)
						.set({
							attempts,
							claim: null,
							leaseUntil: 0,
							nextAt: now + (delayMs ?? backoffMs(attempts)),
							...(gaveUp ? { state: "failed" } : {}),
						})
						.where(deliveryWhere(delivery)),
				)
				return gaveUp
			}),
		extendDeliveries: (deliveries) =>
			Effect.gen(function* () {
				// Without a condition, the update would change every row.
				if (!Arr.isArrayNonEmpty(deliveries)) return
				const now = yield* Clock.currentTimeMillis
				// Only the lease changes. `finishDelivery` reads `updatedAt` to find a newer body.
				yield* stored(
					db
						.update(channelDeliveries)
						.set({ leaseUntil: now + leaseMs })
						.where(or(...Arr.map(deliveries, deliveryWhere))),
				)
			}),
		liveReplies: stored(
			Effect.gen(function* () {
				const rows = yield* db
					.select()
					.from(channelDeliveries)
					.where(eq(channelDeliveries.state, "live"))
					.orderBy(asc(channelDeliveries.updatedAt))
					.limit(200)
				const replies = yield* Effect.forEach(rows, (row) => {
					const { chat, turn } = row
					if (chat === null || turn === null) return Effect.succeed([])
					return decodeTarget(row.target).pipe(
						Effect.map((target) => [
							{
								organizationId: row.organizationId,
								channelId: row.channelId,
								target,
								chat: Chat.Id.make(chat),
								turn: Turn.Id.make(turn),
							},
						]),
						// The reply can never go out, and each check would log it again.
						Effect.catchTag("SchemaError", (error) =>
							Effect.logError(
								"A stored Channel reply does not decode. OpenBot gives up on it.",
								Cause.fail(error),
							).pipe(
								Effect.annotateLogs({
									channel: row.channelId,
									delivery: row.id,
								}),
								Effect.andThen(
									db
										.update(channelDeliveries)
										.set({ state: "failed" })
										.where(
											and(
												eq(channelDeliveries.id, row.id),
												eq(channelDeliveries.state, "live"),
											),
										),
								),
								Effect.as([]),
							),
						),
					)
				})
				return Arr.flatten(replies)
			}),
		),
		endReply: (reply) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				yield* stored(
					db
						.update(channelDeliveries)
						.set({ state: "failed", updatedAt: now })
						.where(
							and(
								eq(channelDeliveries.chat, reply.chat),
								eq(channelDeliveries.turn, reply.turn),
								eq(channelDeliveries.state, "live"),
							),
						),
				)
			}),
	})
})
export const layer = Layer.effect(ChannelQueue, make)
