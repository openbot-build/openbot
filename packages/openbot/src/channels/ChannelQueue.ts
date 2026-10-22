import { randomUUID } from "node:crypto"
import { ChannelsApi } from "@openbot-build/api"
import { and, asc, eq, lt, lte, sql } from "drizzle-orm"
import { makeWithDefaults } from "drizzle-orm/effect-postgres"
import { Clock, Context, Effect, Layer } from "effect"
import { channelDeliveries, channelInbox } from "../database/Schema.ts"
import type {
	ChannelEvent,
	MessageRef,
	OutboundMessage,
	Target,
} from "./Channel.ts"

/** How long a worker holds a claimed item before another worker may take it. */
const leaseMs = 60_000
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

export type DeliveryKind = "reply" | "request" | "notice"

export interface Delivery {
	readonly id: string
	readonly organizationId: string
	readonly channelId: string
	readonly kind: DeliveryKind
	readonly target: Target
	readonly session: string | null
	readonly turn: string | null
	readonly request: string | null
	readonly message: OutboundMessage
	readonly ref: MessageRef | null
	readonly attempts: number
	readonly claim: string
	/** When the worker took it. A newer body than this must go out again. */
	readonly claimedAt: number
}

const unavailable = () => ChannelsApi.ChannelsUnavailable.make({})
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
		/** Takes the oldest open event of each chat, so each chat keeps its order. */
		readonly claimEvents: Effect.Effect<ReadonlyArray<ClaimedEvent>, Failure>
		readonly finishEvent: (event: ClaimedEvent) => Effect.Effect<void, Failure>
		/** Tries the event again later. After too many tries, it ends. */
		readonly retryEvent: (event: ClaimedEvent) => Effect.Effect<void, Failure>
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
			readonly session: string
			readonly turn: string
			readonly ref: MessageRef | null
		}) => Effect.Effect<void, Failure>
		/** The final answer of a Turn. It changes the running message, or sends a new one. */
		readonly finishReply: (input: {
			readonly organizationId: string
			readonly channelId: string
			readonly target: Target
			readonly session: string
			readonly turn: string
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
		readonly claimDeliveries: Effect.Effect<ReadonlyArray<Delivery>, Failure>
		readonly finishDelivery: (
			delivery: Delivery,
			ref: MessageRef,
		) => Effect.Effect<void, Failure>
		readonly retryDelivery: (
			delivery: Delivery,
			delayMs: number | undefined,
			give: boolean,
		) => Effect.Effect<void, Failure>
		/** The replies of Turns that have not ended yet, to check them after a restart. */
		readonly liveReplies: Effect.Effect<
			ReadonlyArray<{
				readonly organizationId: string
				readonly channelId: string
				readonly target: Target
				readonly session: string
				readonly turn: string
			}>,
			Failure
		>
	}
>()("@openbot-build/openbot/channels/ChannelQueue") {}

type DeliveryRow = typeof channelDeliveries.$inferSelect

const deliveryOf = (
	row: DeliveryRow,
	claim: string,
	claimedAt: number,
): Delivery => ({
	id: row.id,
	organizationId: row.organizationId,
	channelId: row.channelId,
	kind: row.kind as DeliveryKind,
	target: JSON.parse(row.target) as Target,
	session: row.session,
	turn: row.turn,
	request: row.request,
	message: JSON.parse(row.body) as OutboundMessage,
	ref: row.ref === null ? null : (JSON.parse(row.ref) as MessageRef),
	attempts: row.attempts,
	claim,
	claimedAt,
})

export const make = Effect.gen(function* () {
	const db = yield* makeWithDefaults()
	const stored = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
		effect.pipe(Effect.mapError(unavailable))
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
			Effect.gen(function* () {
				if (events.length === 0) return
				const now = yield* Clock.currentTimeMillis
				yield* stored(
					db
						.insert(channelInbox)
						.values(
							events.map((event, index) => ({
								organizationId,
								channelId,
								eventId: event.eventId,
								conversationKey: event.conversation.key,
								event: JSON.stringify(event),
								// Events of one request keep their order.
								receivedAt: now + index,
								nextAt: now,
							})),
						)
						.onConflictDoNothing(),
				)
			}),
		claimEvents: stored(
			db.transaction((tx) =>
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis
					const claim = randomUUID()
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
					for (const row of rows)
						yield* tx
							.update(channelInbox)
							.set({ claim, leaseUntil: now + leaseMs })
							.where(
								and(
									eq(channelInbox.channelId, row.channelId),
									eq(channelInbox.eventId, row.eventId),
								),
							)
					return rows.map((row): ClaimedEvent => ({
						organizationId: row.organizationId,
						channelId: row.channelId,
						event: JSON.parse(row.event) as ChannelEvent,
						attempts: row.attempts,
						claim,
					}))
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
				yield* stored(
					db
						.update(channelInbox)
						.set({
							attempts,
							claim: null,
							leaseUntil: 0,
							nextAt: now + backoffMs(attempts),
							...(attempts >= maxAttempts ? { doneAt: now } : {}),
						})
						.where(eventWhere(event)),
				)
			}),
		notice: (input) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				yield* stored(
					db.insert(channelDeliveries).values({
						id: randomUUID(),
						organizationId: input.organizationId,
						channelId: input.channelId,
						kind: "notice",
						target: JSON.stringify(input.target),
						body: JSON.stringify(input.message),
						state: "pending",
						nextAt: now,
						updatedAt: now,
					}),
				)
			}),
		startReply: (input) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				yield* stored(
					db
						.insert(channelDeliveries)
						.values({
							id: randomUUID(),
							organizationId: input.organizationId,
							channelId: input.channelId,
							kind: "reply",
							target: JSON.stringify(input.target),
							session: input.session,
							turn: input.turn,
							body: JSON.stringify({ markdown: "" }),
							ref: input.ref === null ? null : JSON.stringify(input.ref),
							state: "live",
							nextAt: now,
							updatedAt: now,
						})
						.onConflictDoNothing(),
				)
			}),
		finishReply: (input) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				yield* stored(
					db
						.insert(channelDeliveries)
						.values({
							id: randomUUID(),
							organizationId: input.organizationId,
							channelId: input.channelId,
							kind: "reply",
							target: JSON.stringify(input.target),
							session: input.session,
							turn: input.turn,
							body: JSON.stringify(input.message),
							state: "pending",
							nextAt: now,
							updatedAt: now,
						})
						.onConflictDoUpdate({
							target: [channelDeliveries.session, channelDeliveries.turn],
							set: {
								body: JSON.stringify(input.message),
								state: "pending",
								nextAt: now,
								updatedAt: now,
							},
							// A reply that already went out stays as it is.
							setWhere: sql`${channelDeliveries.state} = 'live'`,
						}),
				)
			}),
		putRequest: (input) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				yield* stored(
					db
						.insert(channelDeliveries)
						.values({
							id: randomUUID(),
							organizationId: input.organizationId,
							channelId: input.channelId,
							kind: "request",
							target: JSON.stringify(input.target),
							request: input.request,
							body: JSON.stringify(input.message),
							state: "pending",
							nextAt: now,
							updatedAt: now,
						})
						.onConflictDoUpdate({
							target: [channelDeliveries.channelId, channelDeliveries.request],
							set: {
								body: JSON.stringify(input.message),
								state: "pending",
								attempts: 0,
								nextAt: now,
								updatedAt: now,
							},
						}),
				)
			}),
		requestRef: (channelId, request) =>
			stored(
				db
					.select({ ref: channelDeliveries.ref })
					.from(channelDeliveries)
					.where(
						and(
							eq(channelDeliveries.channelId, channelId),
							eq(channelDeliveries.request, request),
						),
					),
			).pipe(
				Effect.map((rows) => {
					const ref = rows[0]?.ref
					return ref === undefined || ref === null
						? null
						: (JSON.parse(ref) as MessageRef)
				}),
			),
		claimDeliveries: stored(
			db.transaction((tx) =>
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis
					const claim = randomUUID()
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
					for (const row of rows)
						yield* tx
							.update(channelDeliveries)
							.set({ claim, leaseUntil: now + leaseMs })
							.where(eq(channelDeliveries.id, row.id))
					return rows.map((row) => deliveryOf(row, claim, now))
				}),
			),
		),
		finishDelivery: (delivery, ref) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				yield* stored(
					db
						.update(channelDeliveries)
						.set({
							ref: JSON.stringify(ref),
							claim: null,
							leaseUntil: 0,
							updatedAt: now,
							// A newer body that came while it was sent goes out again.
							state: sql`CASE WHEN ${channelDeliveries.updatedAt} > ${delivery.claimedAt} THEN 'pending' ELSE 'done' END`,
						})
						.where(deliveryWhere(delivery)),
				)
			}),
		retryDelivery: (delivery, delayMs, give) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				const attempts = delivery.attempts + 1
				yield* stored(
					db
						.update(channelDeliveries)
						.set({
							attempts,
							claim: null,
							leaseUntil: 0,
							nextAt: now + (delayMs ?? backoffMs(attempts)),
							...(give || attempts >= maxAttempts ? { state: "failed" } : {}),
						})
						.where(deliveryWhere(delivery)),
				)
			}),
		liveReplies: stored(
			db
				.select()
				.from(channelDeliveries)
				.where(eq(channelDeliveries.state, "live"))
				.limit(200),
		).pipe(
			Effect.map((rows) =>
				rows.flatMap((row) =>
					row.session === null || row.turn === null
						? []
						: [
								{
									organizationId: row.organizationId,
									channelId: row.channelId,
									target: JSON.parse(row.target) as Target,
									session: row.session,
									turn: row.turn,
								},
							],
				),
			),
		),
	})
})
export const layer = Layer.effect(ChannelQueue, make)
