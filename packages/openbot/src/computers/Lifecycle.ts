import {
	type MemberExecution,
	Store,
	storage,
	transactionFailures,
	type Fence,
	type Key,
} from "../execution/Store.ts"
import {
	type Developers,
	Authorization,
	Computers as ComputerData,
	Execution,
	ExecutionIdentity,
	type Caller,
	executionCallers,
} from "@openbot-build/domain"
import type { SecretStorageError } from "../secrets/Secrets.ts"
import { and, eq, isNull } from "drizzle-orm"
import {
	Array as Arr,
	Clock,
	Context,
	Crypto,
	Effect,
	Layer,
	Option,
	Schema,
	Stream,
} from "effect"
import { Hex } from "effect/encoding"
import * as Check from "../authorization/Check.ts"
import { AuditLog } from "../audit/AuditLog.ts"
import { computerKey } from "../audit/Resources.ts"
import * as Db from "../database/Database.ts"
import { computers, computerUsage, computerAccess } from "../database/Schema.ts"
import { Observation } from "../execution/Observation.ts"
import {
	Registry,
	type Access as ExecutionAccess,
} from "../execution/Engine.ts"
import { type End } from "../execution/Program.ts"
import * as Send from "../execution/Send.ts"
import * as Access from "./Access.ts"
import * as Activity from "./Activity.ts"
import { ComputerProviders } from "./ComputerProviders.ts"

export const Action = Schema.TaggedUnion({
	Create: { request: ComputerData.CreateComputerRequest },
	Remove: { id: Schema.String },
	Pause: { id: Schema.String },
	Resume: { id: Schema.String },
})
export type Action = typeof Action.Type
const Snapshot = Schema.Struct({
	id: Schema.String,
	ownerUserId: Schema.NullOr(Schema.String),
	source: Schema.Literals(["provider", "connector"]),
	providerId: Schema.NullOr(Schema.String),
	ref: Schema.NullOr(Schema.String),
	version: Schema.Int,
	state: ComputerData.ComputerState,
})
export const Input = Schema.Struct({ action: Action, computer: Snapshot })
export type Input = typeof Input.Type
export const Result = Schema.Struct({ ref: Schema.NullOr(Schema.String) })
export interface Service {
	readonly submit: (
		identity: ExecutionIdentity,
		commandKey: Execution.CommandKey,
		action: Action,
		ownerExecutionId?: Execution.Id | undefined,
	) => Effect.Effect<
		Execution.Receipt,
		| ComputerData.ComputerConflict
		| ComputerData.ComputerInvalid
		| ComputerData.ComputerNotFound
		| ComputerData.ComputerProviderFailed
		| ComputerData.ComputerProviderInUse
		| ComputerData.ComputerProviderNotFound
		| ComputerData.ComputerUnsupported
		| ComputerData.ComputersUnavailable
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.KeyConflict
		| Execution.NotFound
		| Developers.StorageFailure
		| Check.Errors
	>
	readonly execute: (
		identity: ExecutionIdentity,
		action: Action,
	) => Effect.Effect<
		string,
		| ComputerData.ComputerConflict
		| ComputerData.ComputerInvalid
		| ComputerData.ComputerNotFound
		| ComputerData.ComputerProviderFailed
		| ComputerData.ComputerProviderInUse
		| ComputerData.ComputerProviderNotFound
		| ComputerData.ComputerUnsupported
		| ComputerData.ComputersUnavailable
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.KeyConflict
		| Execution.NotFound
		| Developers.StorageFailure
		| Check.Errors
	>
	readonly load: (key: Key) => Effect.Effect<
		{
			saved: MemberExecution
			input: Input
		},
		Execution.Forbidden | Execution.NotFound | Execution.StorageError
	>
	readonly authorize: (
		key: Key,
		actor: Caller,
		access: ExecutionAccess,
	) => Effect.Effect<
		undefined,
		Execution.Forbidden | Execution.NotFound | Execution.StorageError
	>
	readonly remember: (
		fence: Fence,
		result: Schema.Json,
	) => Effect.Effect<
		void,
		Execution.Forbidden | Execution.NotFound | Developers.StorageFailure
	>
	readonly complete: (
		fence: Fence,
		result: Schema.Json,
	) => Effect.Effect<
		undefined,
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.NotFound
		| Schema.SchemaError
		| SecretStorageError
		| Execution.StorageError
	>
	readonly finish: (
		fence: Fence,
		end: End,
	) => Effect.Effect<
		void,
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.NotFound
		| Schema.SchemaError
		| SecretStorageError
		| Execution.StorageError
	>
}

export class Lifecycle extends Context.Service<Lifecycle, Service>()(
	"@openbot-build/openbot/computers/Lifecycle",
) {}

export const make = Effect.gen(function* () {
	const db = yield* Db.make
	const store = yield* Store
	const observation = yield* Observation
	const crypto = yield* Crypto.Crypto
	const checks = yield* Check.make
	const rights = yield* Access.make
	const providers = yield* ComputerProviders
	const registry = yield* Registry
	const audit = yield* AuditLog
	const activity = yield* Activity.make
	const authorizeInput = (
		identity: ExecutionIdentity,
		input: Input,
		need: "read" | "use" | "write",
	) =>
		Effect.gen(function* () {
			const target = Authorization.Computer.make({
				organizationId: identity.owner.organizationId,
				ownerUserId: input.computer.ownerUserId,
				id: input.computer.id,
			})
			yield* Check.execution(checks, identity, {
				action: need,
				resource: target,
			})
			if (
				input.action._tag === "Create" &&
				need !== "read" &&
				input.computer.providerId !== null
			)
				for (const caller of executionCallers(identity))
					yield* providers.get(caller, input.computer.providerId, "use")
			if (input.action._tag !== "Create" && need !== "read")
				yield* rights.execution(identity, input.computer.id, need)
		}).pipe(
			Effect.catchTags({
				Forbidden: () => Effect.fail(Execution.Forbidden.make({})),
				Pending: () => Effect.fail(Execution.Forbidden.make({})),
				PolicyUnavailable: (cause) =>
					Effect.fail(Execution.StorageError.make({ cause })),
				ComputerStorageError: (cause) =>
					Effect.fail(Execution.StorageError.make({ cause })),
			}),
		)
	const load = Effect.fn("ComputerLifecycle.load")(function* (key: Key) {
		const saved = yield* store.loadMember(key)
		const input = yield* Schema.decodeUnknownEffect(Input)(saved.input).pipe(
			Effect.orDie,
		)
		if (
			saved.workflow !== Activity.workflowName ||
			key.namespace !== saved.identity.owner.organizationId ||
			saved.record.resource.kind !== "Computer" ||
			saved.record.resource.id !== input.computer.id
		)
			return yield* Execution.Forbidden.make({})
		return { saved, input }
	})
	const authorize = Effect.fn("ComputerLifecycle.authorize")(
		function* (key: Key, actor: Caller, access: ExecutionAccess) {
			const { saved, input } = yield* load(key)
			if (actor.organizationId !== saved.identity.owner.organizationId)
				return yield* Execution.Forbidden.make({})
			const need =
				access === "read"
					? "read"
					: input.action._tag === "Pause" || input.action._tag === "Resume"
						? "use"
						: "write"
			if (access === "advance" || access === "replay") {
				yield* authorizeInput(saved.identity, input, need)
				const parent = yield* store.ownership(key)
				if (parent.ownerExecutionId !== undefined) {
					const parentKey = yield* store.locate(
						parent.ownerExecutionId,
						actor.organizationId,
					)
					const owner = yield* store.loadMember(parentKey)
					if (
						Execution.isTerminal(owner.record.status) ||
						owner.record.status === "cancelling"
					)
						return yield* Execution.Forbidden.make({})
					const feature = yield* registry.get(owner.workflow)
					if (Option.isNone(feature)) return yield* Execution.Forbidden.make({})
					yield* feature.value.authorize(
						parentKey,
						owner.identity.actor,
						"advance",
					)
				}
			} else
				yield* checks
					.check(actor, {
						action: need,
						resource: Authorization.Computer.make({
							organizationId: key.namespace,
							ownerUserId: input.computer.ownerUserId,
							id: input.computer.id,
						}),
					})
					.pipe(
						Effect.catchTags({
							Forbidden: () => Effect.fail(Execution.Forbidden.make({})),
							Pending: () => Effect.fail(Execution.Forbidden.make({})),
							PolicyUnavailable: (cause) =>
								Effect.fail(Execution.StorageError.make({ cause })),
						}),
					)
		},
		Effect.catchTags({
			ComputerNotFound: () => Effect.fail(Execution.Forbidden.make({})),
			ComputerProviderNotFound: () => Effect.fail(Execution.Forbidden.make({})),
			ComputersUnavailable: (cause) =>
				Effect.fail(Execution.StorageError.make({ cause })),
			ComputerConflict: (cause) =>
				Effect.fail(Execution.StorageError.make({ cause })),
			ComputerInvalid: (cause) =>
				Effect.fail(Execution.StorageError.make({ cause })),
			ComputerProviderFailed: (cause) =>
				Effect.fail(Execution.StorageError.make({ cause })),
			ComputerProviderInUse: (cause) =>
				Effect.fail(Execution.StorageError.make({ cause })),
		}),
	)
	const submit = Effect.fn("ComputerLifecycle.submit")(function* (
		identity: ExecutionIdentity,
		commandKey: Execution.CommandKey,
		action: Action,
		ownerExecutionId?: Execution.Id,
	) {
		const namespace = identity.owner.organizationId
		return yield* store
			.accept(
				namespace,
				commandKey,
				{
					actor: identity.owner,
					body: yield* Schema.encodeEffect(
						Schema.Struct({ identity: ExecutionIdentity, action: Action }),
					)({ identity, action }),
				},
				(allocate) =>
					Effect.gen(function* () {
						let computer: typeof Snapshot.Type
						if (action._tag === "Create") {
							const request = action.request
							const id =
								"cmp_" +
								Hex.encode(yield* crypto.randomBytes(16).pipe(Effect.orDie))
							computer = {
								id,
								ownerUserId:
									request.shared === true ? null : identity.owner.userId,
								source:
									request.source._tag === "Provider" ? "provider" : "connector",
								providerId:
									request.source._tag === "Provider"
										? request.source.provider
										: null,
								ref: null,
								version: 0,
								state: "starting",
							}
							yield* authorizeInput(identity, { action, computer }, "write")
							const now = yield* Clock.currentTimeMillis
							yield* db.insert(computers).values({
								...computer,
								organizationId: namespace,
								name: request.name,
								createdBy: identity.botId ?? identity.actor.userId,
								createdAt: now,
								updatedAt: now,
								lastActiveAt: null,
								template:
									request.source._tag === "Provider"
										? request.source.template
										: null,
								pauseAfter:
									request.source._tag === "Connector"
										? null
										: request.pauseAfter === undefined
											? 600
											: request.pauseAfter,
								features: yield* Schema.encodeEffect(
									Schema.fromJsonString(ComputerData.ComputerFeatures),
								)({
									pause: request.source._tag === "Provider",
									desktop: request.desktop === true,
									ports: request.source._tag === "Provider",
								}),
							})
						} else {
							yield* rights
								.execution(
									identity,
									action.id,
									action._tag === "Remove" ? "write" : "use",
								)
								.pipe(
									Effect.catchTag("ComputerStorageError", (cause) =>
										Effect.fail(Execution.StorageError.make({ cause })),
									),
								)
							const row = yield* activity.ready(namespace, action.id)
							computer = yield* Schema.decodeUnknownEffect(Snapshot)(row)
							yield* authorizeInput(
								identity,
								{ action, computer },
								action._tag === "Remove" ? "write" : "use",
							)
							if (action._tag !== "Remove" && row.source !== "provider")
								return yield* ComputerData.ComputerUnsupported.make({
									feature: "pause",
								})
						}
						const input = { action, computer }
						const key = yield* allocate({
							workflow: Activity.workflowName,
							identity,
							...(ownerExecutionId === undefined ? {} : { ownerExecutionId }),
							resource: { kind: "Computer", id: computer.id },
							input: yield* Schema.encodeEffect(Input)(input),
						})
						return { executionId: key.id, start: true }
					}),
			)
			.pipe(transactionFailures)
	})
	const wait = Effect.fn("ComputerLifecycle.wait")(function* (key: Key) {
		const done = yield* observation.observe(key, 0).pipe(
			Stream.filter(
				(event) =>
					event.body._tag === "State" &&
					(Execution.isTerminal(event.body.status) ||
						event.body.status === "outcome_unknown"),
			),
			Stream.runHead,
		)
		const current = yield* store.get(key)
		if (Option.isNone(done) || current.status !== "completed")
			return yield* ComputerData.ComputerConflict.make({
				version: 0,
				executionId: key.id,
			})
		return current.resource.id
	})
	const execute = Effect.fn("ComputerLifecycle.execute")(function* (
		identity: ExecutionIdentity,
		action: Action,
	) {
		const source = yield* Send.Current
		let ownerExecutionId: Execution.Id | undefined
		let commandKey: Execution.CommandKey
		if (Option.isSome(source) && source.value._tag === "Call") {
			const parent = yield* store.loadMember(source.value.reference)
			identity = parent.identity
			ownerExecutionId = source.value.reference.id
			commandKey = Execution.CommandKey.make(
				`computer:${source.value.reference.callId}:${action._tag}`,
			)
		} else
			commandKey = Execution.CommandKey.make(
				yield* crypto.randomUUIDv4().pipe(Effect.orDie),
			)
		const receipt = yield* submit(
			identity,
			commandKey,
			action,
			ownerExecutionId,
		)
		const key = {
			namespace: identity.owner.organizationId,
			id: receipt.executionId,
		}
		const id = yield* wait(key)
		yield* authorizeInput(identity, (yield* load(key)).input, "read")
		return id
	})
	const openUsage = (row: typeof computers.$inferSelect, now: number) =>
		Effect.gen(function* () {
			const open = yield* db
				.select({ id: computerUsage.id })
				.from(computerUsage)
				.where(
					and(
						eq(computerUsage.organizationId, row.organizationId),
						eq(computerUsage.computerId, row.id),
						isNull(computerUsage.endedAt),
					),
				)
				.limit(1)
			if (open.length === 0)
				yield* db.insert(computerUsage).values({
					organizationId: row.organizationId,
					computerId: row.id,
					ownerUserId: row.ownerUserId,
					startedAt: now,
				})
		})
	const remember = (fence: Fence, result: Schema.Json) =>
		Effect.gen(function* () {
			const { input } = yield* load(fence)
			if (input.action._tag !== "Create") return
			const value = yield* Schema.decodeUnknownEffect(Result)(result)
			if (value.ref === null) return
			// A late result preserves the resource and its use. Only complete may advance state.
			const found = yield* activity.row(
				fence.namespace,
				input.computer.id,
				true,
			)
			if (Option.isNone(found) || found.value.ref !== null) return
			yield* db
				.update(computers)
				.set({ ref: value.ref })
				.where(Activity.where(fence.namespace, input.computer.id))
			yield* openUsage(found.value, yield* Clock.currentTimeMillis)
		}).pipe(transactionFailures)
	const complete = (fence: Fence, result: Schema.Json) =>
		Effect.gen(function* () {
			const { saved, input } = yield* load(fence)
			const value = yield* Schema.decodeUnknownEffect(Result)(result)
			return yield* store
				.commit(
					fence,
					{
						status: "completed",
						events: [{ _tag: "Result", resource: saved.record.resource }],
					},
					Effect.gen(function* () {
						const row = yield* activity.row(
							fence.namespace,
							input.computer.id,
							true,
						)
						if (Option.isNone(row))
							return yield* Execution.NotFound.make({ id: fence.id })
						const now = yield* Clock.currentTimeMillis
						const state =
							input.action._tag === "Remove"
								? "offline"
								: input.action._tag === "Pause"
									? "paused"
									: input.computer.source === "connector"
										? "offline"
										: "running"
						yield* db
							.update(computers)
							.set({
								state,
								ref: value.ref ?? row.value.ref,
								updatedAt: now,
								lastActiveAt: now,
							})
							.where(Activity.where(fence.namespace, row.value.id))
						if (state === "running") yield* openUsage(row.value, now)
						if (state !== "running")
							yield* db
								.update(computerUsage)
								.set({ endedAt: now })
								.where(
									and(
										eq(computerUsage.organizationId, fence.namespace),
										eq(computerUsage.computerId, row.value.id),
										isNull(computerUsage.endedAt),
									),
								)
						if (
							input.action._tag === "Create" &&
							saved.identity.botId !== undefined
						)
							yield* db
								.insert(computerAccess)
								.values({
									organizationId: fence.namespace,
									computerId: row.value.id,
									bot: saved.identity.botId,
									grantedBy: saved.identity.actor.userId,
									grantedAt: now,
								})
								.onConflictDoNothing()
						if (input.action._tag === "Remove")
							yield* db
								.delete(computers)
								.where(Activity.where(fence.namespace, row.value.id))
						if (
							input.action._tag === "Create" ||
							input.action._tag === "Remove"
						)
							yield* audit
								.record({
									organizationId: fence.namespace,
									actor: saved.identity.actor,
									action:
										input.action._tag === "Create"
											? "computer.created"
											: "computer.deleted",
									resource: computerKey({
										organizationId: fence.namespace,
										id: row.value.id,
										owner:
											row.value.ownerUserId === null
												? { _tag: "Organization" }
												: { _tag: "Member", userId: row.value.ownerUserId },
										kind: "computer",
									}),
									details: { executionId: fence.id },
								})
								.pipe(storage)
					}),
				)
				.pipe(transactionFailures)
		})
	const finish = (fence: Fence, end: End) =>
		Effect.gen(function* () {
			const { input } = yield* load(fence)
			const calls = yield* store.calls(fence)
			const changed =
				input.action._tag === "Create" ||
				Arr.some(calls, (call) => call.status !== "intended")
			const change = changed
				? db
						.update(computers)
						.set({ state: "failed", updatedAt: yield* Clock.currentTimeMillis })
						.where(Activity.where(fence.namespace, input.computer.id))
						.pipe(Effect.asVoid)
				: Effect.void
			if (end.status === "cancelled")
				return yield* store
					.finishCancellation(fence, end.epoch, () =>
						change.pipe(Effect.as([])),
					)
					.pipe(Effect.asVoid)
			return yield* store.commit(fence, end, change)
		}).pipe(transactionFailures)
	return Lifecycle.of({
		submit,
		execute,
		load,
		authorize,
		remember,
		complete,
		finish,
	})
})

export const layer = Layer.effect(Lifecycle, make)
