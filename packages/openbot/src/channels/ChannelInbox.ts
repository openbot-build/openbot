import {
	type MemberExecution,
	Store,
	storage,
	type Fence,
	type Key,
} from "../execution/Store.ts"
import * as ChannelAdmission from "./ChannelAdmission.ts"
import { Execution } from "@openbot-build/domain"
import { and, desc, eq } from "drizzle-orm"
import { Clock, Context, Crypto, Effect, Layer, Option, Schema } from "effect"
import { Hex } from "effect/encoding"
import { SqlClient } from "effect/sql"
import { ownerKey } from "../apps/StoredConnections.ts"
import * as Db from "../database/Database.ts"
import { channelInbox } from "../database/Schema.ts"
import { ChannelEventSchema, type ChannelEvent } from "./Channel.ts"
import { Channels } from "./Channels.ts"

export const workflowName = "openbot.channel-input"
export const Input = Schema.Struct({
	channelId: Schema.String,
	event: ChannelEventSchema,
	predecessor: Schema.NullOr(
		Schema.Struct({ namespace: Schema.String, id: Execution.Id }),
	),
})
const codec = Schema.toCodecJson(Input)
const eventCodec = Schema.toCodecJson(ChannelEventSchema)
export interface Service {
	readonly load: (key: Key) => Effect.Effect<
		{
			execution: MemberExecution
			input: typeof Input.Type
		},
		Execution.Forbidden | Execution.NotFound | Execution.StorageError
	>
	readonly receive: (
		organizationId: string,
		channelId: string,
		events: ReadonlyArray<ChannelEvent>,
	) => Effect.Effect<
		void,
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.KeyConflict
		| Execution.NotFound
		| Execution.StorageError
	>
	readonly finish: (
		fence: Fence,
		outcome:
			| {
					readonly status: "completed" | "failed" | "interrupted"
					readonly failure?: Execution.Failure
			  }
			| { readonly status: "cancelled"; readonly epoch: number },
	) => Effect.Effect<
		void,
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.NotFound
		| Execution.StorageError
	>
}

export class ChannelInbox extends Context.Service<ChannelInbox, Service>()(
	"@openbot-build/openbot/channels/ChannelInbox",
) {}

const make = Effect.gen(function* () {
	const db = yield* Db.make
	const sql = yield* SqlClient.SqlClient
	const crypto = yield* Crypto.Crypto
	const store = yield* Store
	const channels = yield* Channels
	const admit = yield* ChannelAdmission.make
	const load = (key: Key) =>
		Effect.gen(function* () {
			const execution = yield* store.loadMember(key)
			const input = yield* Schema.decodeUnknownEffect(Input)(execution.input)
			if (
				execution.workflow !== workflowName ||
				execution.record.resource.kind !== "ChannelInput"
			)
				return yield* Execution.Forbidden.make({})
			return { execution, input }
		}).pipe(storage)
	/** The inbox key and command receipt commit together. The engine gets only their reference. */
	const receive = (
		organizationId: string,
		channelId: string,
		events: ReadonlyArray<ChannelEvent>,
	) =>
		Effect.forEach(
			events,
			(event) =>
				sql.withTransaction(
					Effect.gen(function* () {
						yield* admit(organizationId, channelId)
						// One conversation lock defines input order on every node, including equal receive times.
						yield* sql`select pg_advisory_xact_lock(hashtextextended(${channelId + ":" + event.conversation.key}, 0))`
						const prior = yield* db
							.select()
							.from(channelInbox)
							.where(
								and(
									eq(channelInbox.channelId, channelId),
									eq(channelInbox.eventId, event.eventId),
								),
							)
							.limit(1)
						if (prior.length !== 0) return
						const authority = yield* channels.authority(
							organizationId,
							channelId,
						)
						if (Option.isNone(authority))
							return yield* Execution.Forbidden.make({})
						const caller = authority.value
						const namespace = ownerKey(caller)
						const previous = yield* db
							.select()
							.from(channelInbox)
							.where(
								and(
									eq(channelInbox.channelId, channelId),
									eq(channelInbox.conversationKey, event.conversation.key),
								),
							)
							.orderBy(desc(channelInbox.position))
							.limit(1)
						const last = previous[0]
						if (last !== undefined && last.executionId === null)
							return yield* Execution.StorageError.make({
								cause: new Error("The Channel inbox needs data conversion."),
							})
						const predecessor =
							last?.executionId == null
								? null
								: yield* store.locate(
										Execution.Id.make(last.executionId),
										organizationId,
									)
						const input = { channelId, event, predecessor }
						const receipt = yield* store.accept(
							namespace,
							Execution.CommandKey.make(
								"channel-input:" +
									Hex.encode(
										yield* crypto.digest(
											"SHA-256",
											new TextEncoder().encode(
												channelId.length + ":" + channelId + event.eventId,
											),
										),
									),
							),
							{
								actor: caller,
								body: yield* Schema.encodeEffect(eventCodec)(event),
							},
							(create) =>
								Effect.gen(function* () {
									const key = yield* create({
										workflow: workflowName,
										resource: {
											kind: "ChannelInput",
											id: channelId + ":" + event.eventId,
										},
										identity: {
											owner: { organizationId, userId: caller.userId },
											actor: caller,
										},
										input: yield* Schema.encodeEffect(codec)(input),
									})
									return { executionId: key.id, start: true }
								}),
						)
						const now = yield* Clock.currentTimeMillis
						yield* db.insert(channelInbox).values({
							organizationId,
							channelId,
							eventId: event.eventId,
							conversationKey: event.conversation.key,
							event: receipt.executionId,
							executionId: receipt.executionId,
							receivedAt: now,
							nextAt: now,
						})
					}),
				),
			{ discard: true },
		).pipe(storage)
	const finish = (
		fence: Fence,
		outcome:
			| {
					readonly status: "completed" | "failed" | "interrupted"
					readonly failure?: Execution.Failure
			  }
			| { readonly status: "cancelled"; readonly epoch: number },
	) =>
		Effect.gen(function* () {
			const { input } = yield* load(fence)
			const end = db
				.update(channelInbox)
				.set({ doneAt: yield* Clock.currentTimeMillis })
				.where(
					and(
						eq(channelInbox.channelId, input.channelId),
						eq(channelInbox.eventId, input.event.eventId),
					),
				)
				.pipe(Effect.asVoid)
			if (outcome.status === "cancelled")
				return yield* store.finishCancellation(fence, outcome.epoch, () =>
					end.pipe(Effect.as([])),
				)
			return yield* store.commit(fence, outcome, end)
		}).pipe(storage, Effect.asVoid)
	return ChannelInbox.of({ load, receive, finish })
})

export const layer = Layer.effect(ChannelInbox, make)
