import {
	type MemberExecution,
	Store,
	storage,
	type Fence,
	type Key,
} from "../execution/Store.ts"
import {
	type ChannelEvent,
	MessageRef,
	OutboundMessage,
	TargetSchema,
	type Target,
} from "./Channel.ts"
import {
	type PlatformError,
	Clock,
	Context,
	Crypto,
	Effect,
	Layer,
	Schema,
} from "effect"
import type { SecretStorageError } from "../secrets/Secrets.ts"
import * as ChannelAdmission from "./ChannelAdmission.ts"
import { Channels as Domain, Execution } from "@openbot-build/domain"
import { and, eq } from "drizzle-orm"
import { Hex } from "effect/encoding"
import { SqlClient } from "effect/sql"
import * as Db from "../database/Database.ts"
import { channelDeliveries } from "../database/Schema.ts"
import * as Failures from "../errors/Failures.ts"
import { ChannelInbox } from "./ChannelInbox.ts"

export const workflowName = "openbot.channel-delivery"
export const Input = Schema.Struct({
	channelId: Schema.String,
	deliveryId: Schema.String,
	sourceExecutionId: Execution.Id,
	target: TargetSchema,
	message: OutboundMessage,
	predecessor: Schema.NullOr(
		Schema.Struct({ namespace: Schema.String, id: Execution.Id }),
	),
})
const codec = Schema.toCodecJson(Input)
const messageCodec = Schema.toCodecJson(OutboundMessage)
const targetCodec = Schema.toCodecJson(TargetSchema)
const refCodec = Schema.fromJsonString(MessageRef)
export interface Service {
	readonly load: (key: Key) => Effect.Effect<
		{
			execution: MemberExecution
			input: typeof Input.Type
		},
		Execution.Forbidden | Execution.NotFound | Execution.StorageError
	>
	readonly reference: (
		id: string,
	) => Effect.Effect<MessageRef | null, Execution.StorageError>
	readonly finish: (
		fence: Fence,
		outcome:
			| {
					readonly status: "completed" | "failed" | "interrupted"
					readonly failure?: Execution.Failure
					readonly ref?: MessageRef
			  }
			| { readonly status: "cancelled"; readonly epoch: number },
	) => Effect.Effect<
		void,
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.NotFound
		| Execution.StorageError
	>
	readonly receive: (
		organizationId: string,
		channelId: string,
		events: Parameters<
			(
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
		>[2],
	) => Effect.Effect<void, Domain.ChannelsUnavailable>
	readonly notice: (
		source: Fence,
		step: string,
		input: {
			readonly channelId: string
			readonly target: Target
			readonly message: OutboundMessage
			readonly request?: string
		},
	) => Effect.Effect<
		Execution.Receipt,
		| Domain.ChannelConflict
		| Domain.ChannelNotFound
		| Domain.ChannelsUnavailable
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.KeyConflict
		| Execution.NotFound
		| PlatformError.PlatformError
		| Schema.SchemaError
		| SecretStorageError
		| Execution.StorageError
	>
	readonly putRequest: (
		source: Fence,
		step: string,
		input: Parameters<
			(
				source: Fence,
				step: string,
				input: {
					readonly channelId: string
					readonly target: Target
					readonly message: OutboundMessage
					readonly request?: string
				},
			) => Effect.Effect<
				Execution.Receipt,
				| Domain.ChannelConflict
				| Domain.ChannelNotFound
				| Domain.ChannelsUnavailable
				| Execution.Conflict
				| Execution.Forbidden
				| Execution.KeyConflict
				| Execution.NotFound
				| PlatformError.PlatformError
				| Schema.SchemaError
				| SecretStorageError
				| Execution.StorageError
			>
		>[2] & { readonly request: string },
	) => Effect.Effect<
		Execution.Receipt,
		| Domain.ChannelConflict
		| Domain.ChannelNotFound
		| Domain.ChannelsUnavailable
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.KeyConflict
		| Execution.NotFound
		| PlatformError.PlatformError
		| Schema.SchemaError
		| SecretStorageError
		| Execution.StorageError
	>
}

export class ChannelQueue extends Context.Service<ChannelQueue, Service>()(
	"@openbot-build/openbot/channels/ChannelQueue",
) {}

const make = Effect.gen(function* () {
	const db = yield* Db.make
	const store = yield* Store
	const sql = yield* SqlClient.SqlClient
	const crypto = yield* Crypto.Crypto
	const inbox = yield* ChannelInbox
	const admit = yield* ChannelAdmission.make
	const submit = (
		source: Fence,
		step: string,
		input: {
			readonly channelId: string
			readonly target: Target
			readonly message: OutboundMessage
			readonly request?: string
		},
	) =>
		Effect.gen(function* () {
			const saved = yield* store.loadMember(source)
			const body = {
				source: source.id,
				step,
				channelId: input.channelId,
				target: yield* Schema.encodeEffect(targetCodec)(input.target),
				message: yield* Schema.encodeEffect(messageCodec)(input.message),
				request: input.request ?? null,
			}
			const commandKey = Execution.CommandKey.make(
				"channel-send:" +
					Hex.encode(
						yield* crypto.digest(
							"SHA-256",
							new TextEncoder().encode(source.id + ":" + step),
						),
					),
			)
			return yield* store.accept(
				source.namespace,
				commandKey,
				{ actor: saved.identity.actor, body },
				(create) =>
					store.commit(
						source,
						{},
						Effect.gen(function* () {
							const organizationId = saved.identity.owner.organizationId
							yield* admit(organizationId, input.channelId)
							if (input.request !== undefined)
								yield* sql`select pg_advisory_xact_lock(hashtextextended(${"channel-card:" + input.channelId + ":" + input.request}, 0))`
							const previous =
								input.request === undefined
									? undefined
									: (yield* db
											.select()
											.from(channelDeliveries)
											.where(
												and(
													eq(channelDeliveries.channelId, input.channelId),
													eq(channelDeliveries.request, input.request),
												),
											)
											.limit(1))[0]
							if (previous !== undefined && previous.executionId === null)
								return yield* Execution.StorageError.make({
									cause: new Error(
										"The Channel delivery needs data conversion.",
									),
								})
							const predecessor =
								previous?.executionId == null
									? null
									: yield* store.locate(
											Execution.Id.make(previous.executionId),
											organizationId,
										)
							const id =
								previous?.id ??
								(yield* crypto.randomUUIDv4().pipe(Effect.orDie))
							const payload = {
								channelId: input.channelId,
								deliveryId: id,
								sourceExecutionId: source.id,
								target: input.target,
								message: input.message,
								predecessor,
							}
							const key = yield* create({
								workflow: workflowName,
								...(saved.context === null ? {} : { context: saved.context }),
								resource: { kind: "ChannelDelivery", id },
								identity: saved.identity,
								input: yield* Schema.encodeEffect(codec)(payload),
							})
							const now = yield* Clock.currentTimeMillis
							yield* db
								.insert(channelDeliveries)
								.values({
									id,
									executionId: key.id,
									organizationId,
									channelId: input.channelId,
									kind: input.request === undefined ? "notice" : "request",
									request: input.request ?? null,
									target: key.id,
									body: key.id,
									state: "pending",
									nextAt: now,
									updatedAt: now,
								})
								.onConflictDoUpdate({
									target: channelDeliveries.id,
									set: {
										executionId: key.id,
										target: key.id,
										body: key.id,
										state: "pending",
										updatedAt: now,
									},
								})
							return { executionId: key.id, start: true }
						}),
					),
			)
		})
	const load = (key: Key) =>
		Effect.gen(function* () {
			const execution = yield* store.loadMember(key)
			const input = yield* Schema.decodeUnknownEffect(Input)(execution.input)
			if (
				execution.workflow !== workflowName ||
				execution.record.resource.kind !== "ChannelDelivery" ||
				execution.record.resource.id !== input.deliveryId
			)
				return yield* Execution.Forbidden.make({})
			return { execution, input }
		}).pipe(storage)
	const reference = (id: string) =>
		Effect.gen(function* () {
			const row = (yield* db
				.select({ ref: channelDeliveries.ref })
				.from(channelDeliveries)
				.where(eq(channelDeliveries.id, id))
				.limit(1))[0]
			return row?.ref == null
				? null
				: yield* Schema.decodeEffect(refCodec)(row.ref)
		}).pipe(storage)
	const finish = (
		fence: Fence,
		outcome:
			| {
					readonly status: "completed" | "failed" | "interrupted"
					readonly failure?: Execution.Failure
					readonly ref?: MessageRef
			  }
			| { readonly status: "cancelled"; readonly epoch: number },
	) =>
		Effect.gen(function* () {
			const { input } = yield* load(fence)
			const end = Effect.gen(function* () {
				// A card keeps the last confirmed message ref, even if its next version is already queued.
				if (outcome.status === "completed" && outcome.ref !== undefined)
					yield* db
						.update(channelDeliveries)
						.set({ ref: yield* Schema.encodeEffect(refCodec)(outcome.ref) })
						.where(eq(channelDeliveries.id, input.deliveryId))
				yield* db
					.update(channelDeliveries)
					.set({
						state: outcome.status === "completed" ? "done" : outcome.status,
						updatedAt: yield* Clock.currentTimeMillis,
					})
					.where(
						and(
							eq(channelDeliveries.id, input.deliveryId),
							eq(channelDeliveries.executionId, fence.id),
						),
					)
			})
			if (outcome.status === "cancelled")
				return yield* store.finishCancellation(fence, outcome.epoch, () =>
					end.pipe(Effect.as([])),
				)
			return yield* store.commit(
				fence,
				{
					status: outcome.status,
					...(outcome.failure === undefined
						? {}
						: { failure: outcome.failure }),
				},
				end,
			)
		}).pipe(storage, Effect.asVoid)
	return ChannelQueue.of({
		load,
		reference,
		finish,
		receive: (
			organizationId: string,
			channelId: string,
			events: Parameters<typeof inbox.receive>[2],
		) =>
			inbox
				.receive(organizationId, channelId, events)
				.pipe(
					Failures.replace("The Channel inbox could not accept input.", () =>
						Domain.ChannelsUnavailable.make({}),
					),
				),
		notice: submit,
		putRequest: (
			source: Fence,
			step: string,
			input: Parameters<typeof submit>[2] & { readonly request: string },
		) => submit(source, step, input),
	})
})

export const layer = Layer.effect(ChannelQueue, make)
