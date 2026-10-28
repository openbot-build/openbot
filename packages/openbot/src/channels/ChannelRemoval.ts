import {
	type MemberExecution,
	Store,
	commandActor,
	storage,
	transactionFailures,
	type Fence,
	type Key,
} from "../execution/Store.ts"
import {
	Authorization,
	Caller,
	Channels as Domain,
	Execution,
} from "@openbot-build/domain"
import { and, eq, inArray, notInArray, or } from "drizzle-orm"
import {
	Array as Arr,
	Clock,
	Context,
	Effect,
	Layer,
	Schema,
	Stream,
} from "effect"
import { SqlClient } from "effect/sql"
import { ownerKey } from "../apps/StoredConnections.ts"
import { AuditLog } from "../audit/AuditLog.ts"
import { organizationKey, segment } from "../audit/Resources.ts"
import * as Check from "../authorization/Check.ts"
import * as Db from "../database/Database.ts"
import {
	channels,
	channelInbox,
	channelDeliveries,
	channelConversations,
	executions,
} from "../database/Schema.ts"
import * as Failures from "../errors/Failures.ts"
import type { Authorize } from "../execution/Engine.ts"
import { Observation } from "../execution/Observation.ts"
import type { End } from "../execution/Program.ts"
import * as ChannelAdmission from "./ChannelAdmission.ts"

export const workflowName = ChannelAdmission.removalWorkflow
const Input = Schema.Struct({ channelId: Schema.String })
const sameCaller = Schema.toEquivalence(Caller)
export interface Service {
	readonly request: (
		caller: Caller,
		channelId: string,
		commandKey: Execution.CommandKey,
	) => Effect.Effect<
		Execution.Receipt,
		| Domain.ChannelConflict
		| Domain.ChannelNotFound
		| Domain.ChannelsUnavailable
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.KeyConflict
		| Execution.NotFound
		| Execution.StorageError
	>
	readonly load: (key: Key) => Effect.Effect<
		{
			execution: MemberExecution
			input: typeof Input.Type
		},
		Execution.Forbidden | Execution.NotFound | Execution.StorageError
	>
	readonly authorize: Authorize
	readonly work: (
		fence: Fence,
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
		end: End | { readonly status: "completed" },
	) => Effect.Effect<
		void,
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.KeyConflict
		| Execution.NotFound
		| Execution.StorageError
	>
}

export class ChannelRemoval extends Context.Service<ChannelRemoval, Service>()(
	"@openbot-build/openbot/channels/ChannelRemoval",
) {}

const make = Effect.gen(function* () {
	const db = yield* Db.make
	const sql = yield* SqlClient.SqlClient
	const store = yield* Store
	const observation = yield* Observation
	const checks = yield* Check.make
	const audit = yield* AuditLog
	const admit = yield* ChannelAdmission.make
	const check = (caller: Caller, channelId: string, action: "read" | "write") =>
		checks
			.check(caller, {
				action,
				resource: Authorization.Channel.make({
					organizationId: caller.organizationId,
					id: channelId,
				}),
			})
			.pipe(
				Effect.catchTags({
					Forbidden: () => Effect.fail(Execution.Forbidden.make({})),
					Pending: () => Effect.fail(Execution.Forbidden.make({})),
				}),
				storage,
			)
	const load = (key: Key) =>
		Effect.gen(function* () {
			const execution = yield* store.loadMember(key)
			const input = yield* Schema.decodeUnknownEffect(Input)(execution.input)
			if (
				execution.workflow !== workflowName ||
				execution.record.resource.kind !== "ChannelRemoval" ||
				execution.record.resource.id !== input.channelId
			)
				return yield* Execution.Forbidden.make({})
			return { execution, input }
		}).pipe(storage)
	const authorize: Authorize = (key, caller, mode) =>
		Effect.gen(function* () {
			const saved = yield* load(key)
			if (
				caller.organizationId !==
					saved.execution.identity.owner.organizationId ||
				((mode === "advance" || mode === "replay") &&
					!sameCaller(caller, saved.execution.identity.actor))
			)
				return yield* Execution.Forbidden.make({})
			yield* check(
				caller,
				saved.input.channelId,
				mode === "read" ? "read" : "write",
			)
		})
	// Read all versions of deliveries and configurations, not just the latest pointers.
	// Watchers keep their root Chat context even when they follow a child execution.
	const active = (organizationId: string, channelId: string) =>
		db
			.select({
				namespace: executions.namespace,
				id: executions.id,
			})
			.from(executions)
			.where(
				and(
					eq(executions.organizationId, organizationId),
					notInArray(executions.status, [
						"completed",
						"failed",
						"cancelled",
						"interrupted",
					]),
					or(
						and(
							eq(executions.resourceKind, "ChannelConfiguration"),
							eq(executions.resourceId, channelId),
						),
						and(
							eq(executions.resourceKind, "ChannelInput"),
							inArray(
								executions.id,
								db
									.select({ id: channelInbox.executionId })
									.from(channelInbox)
									.where(eq(channelInbox.channelId, channelId)),
							),
						),
						and(
							eq(executions.resourceKind, "ChannelDelivery"),
							inArray(
								executions.resourceId,
								db
									.select({ id: channelDeliveries.id })
									.from(channelDeliveries)
									.where(eq(channelDeliveries.channelId, channelId)),
							),
						),
						and(
							eq(executions.resourceKind, "ChannelWatch"),
							eq(executions.contextKind, "Chat"),
							inArray(
								executions.contextId,
								db
									.select({ chat: channelConversations.chat })
									.from(channelConversations)
									.where(eq(channelConversations.channelId, channelId)),
							),
						),
					),
				),
			)
			.pipe(
				Effect.map((rows) =>
					Arr.map(rows, (row) => ({ ...row, id: Execution.Id.make(row.id) })),
				),
				storage,
			)
	const request = (
		caller: Caller,
		channelId: string,
		commandKey: Execution.CommandKey,
	) =>
		Effect.gen(function* () {
			yield* check(caller, channelId, "write")
			return yield* store.accept(
				ownerKey(caller),
				commandKey,
				{
					actor: caller,
					body: { kind: "channel-remove", caller, channelId },
				},
				(create) =>
					Effect.gen(function* () {
						const row = yield* admit(caller.organizationId, channelId, false)
						yield* check(caller, channelId, "write")
						const key = yield* create({
							workflow: workflowName,
							resource: { kind: "ChannelRemoval", id: channelId },
							identity: {
								owner: {
									organizationId: caller.organizationId,
									userId: caller.userId,
								},
								actor: caller,
							},
							input: { channelId },
						})
						// Closing admission and publishing the removal command are one transaction.
						yield* db
							.update(channels)
							.set({
								enabled: false,
								executionId: key.id,
								version: row.version + 1,
								updatedAt: yield* Clock.currentTimeMillis,
							})
							.where(
								and(
									eq(channels.organizationId, caller.organizationId),
									eq(channels.id, channelId),
								),
							)
						return { executionId: key.id, start: true }
					}).pipe(transactionFailures),
			)
		})
	const release = (fence: Fence) =>
		Effect.gen(function* () {
			const saved = yield* load(fence)
			while (true) {
				yield* store.guard(fence)
				const targets = yield* active(
					saved.execution.identity.owner.organizationId,
					saved.input.channelId,
				)
				if (targets.length === 0) return
				for (const target of targets) {
					const child = yield* store.load(target)
					if (Execution.isTerminal(child.record.status)) continue
					yield* store
						.cancel(
							target,
							Execution.CommandKey.make(
								`channel-remove:${fence.id}:${target.id}`,
							),
							commandActor(child.identity),
							store.guard(fence),
						)
						.pipe(
							Effect.catchTag("ExecutionConflict", (error) =>
								store
									.get(target)
									.pipe(
										Effect.flatMap((state) =>
											Execution.isTerminal(state.status)
												? Effect.void
												: Effect.fail(error),
										),
									),
							),
						)
				}
				yield* Effect.forEach(
					targets,
					(target) => observation.observe(target, 0).pipe(Stream.runDrain),
					{ concurrency: "unbounded", discard: true },
				)
			}
		})
	const finish = (fence: Fence, end: End | { readonly status: "completed" }) =>
		Effect.gen(function* () {
			const saved = yield* load(fence)
			// Cancellation stops removal, but it must still wait for the work already stopped.
			yield* release(fence)
			yield* sql
				.withTransaction(
					Effect.gen(function* () {
						const row = (yield* db
							.select()
							.from(channels)
							.where(
								and(
									eq(
										channels.organizationId,
										saved.execution.identity.owner.organizationId,
									),
									eq(channels.id, saved.input.channelId),
								),
							)
							.for("update"))[0]
						if (row === undefined || row.executionId !== fence.id)
							return yield* Execution.Conflict.make({ id: fence.id })
						const change = Effect.gen(function* () {
							if (end.status !== "completed") return
							yield* authorize(fence, saved.execution.identity.actor, "advance")
							yield* db
								.delete(channels)
								.where(
									and(
										eq(channels.organizationId, row.organizationId),
										eq(channels.id, row.id),
									),
								)
							yield* audit
								.record({
									organizationId: row.organizationId,
									actor: saved.execution.identity.actor,
									action: "channel.deleted",
									resource:
										organizationKey(row.organizationId) +
										".channel." +
										segment(row.id),
									details: { executionId: fence.id },
								})
								.pipe(
									Failures.replace(
										"The Channel audit entry could not be saved.",
										() => Domain.ChannelsUnavailable.make({}),
									),
								)
						})
						if (end.status === "cancelled")
							yield* store.finishCancellation(fence, end.epoch, () =>
								change.pipe(Effect.as([])),
							)
						else yield* store.commit(fence, end, change)
					}),
				)
				.pipe(transactionFailures, storage)
		})
	const work = (fence: Fence) =>
		Effect.gen(function* () {
			const saved = yield* load(fence)
			yield* authorize(fence, saved.execution.identity.actor, "advance")
			yield* finish(fence, { status: "completed" })
		})
	return ChannelRemoval.of({ request, load, authorize, work, finish })
})

export const layer = Layer.effect(ChannelRemoval, make)
