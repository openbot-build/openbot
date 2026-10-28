import { Chat } from "@openbot-build/core"
import { Caller, Execution, Delegations as Domain } from "@openbot-build/domain"
import { and, eq } from "drizzle-orm"
import {
	Array as Arr,
	Clock,
	Context,
	Effect,
	HashSet,
	Layer,
	Option,
	Schema,
	Struct,
} from "effect"
import * as DelegationUsage from "../bots/DelegationUsage.ts"
import { Delegations, noUsage } from "../bots/Delegations.ts"
import { Requests } from "../capabilities/Requests.ts"
import * as Db from "../database/Database.ts"
import { executions } from "../database/ExecutionSchema.ts"
import * as Admission from "../execution/Admission.ts"
import { Store, storage, type Key } from "../execution/Store.ts"
import * as ChatHost from "./ChatHost.ts"
import * as ToolOrigins from "./ToolOrigins.ts"

const TurnReference = Schema.Struct({
	chat: Chat.Id,
	host: Schema.optionalKey(ChatHost.ChatHostState),
})
const RequestReference = Schema.Struct({
	source: Execution.Id,
	control: Schema.optionalKey(Domain.LimitControl),
})
const sameCaller = Schema.toEquivalence(Caller)
type Permit = {
	readonly source: Execution.Id
	readonly control: Domain.LimitControl
}

/** Pauses control new work. They do not replace access checks or block saved results. */
export interface Service {
	readonly check: Admission.Check
}

export class WorkAdmission extends Context.Service<WorkAdmission, Service>()(
	"@openbot-build/openbot/chats/WorkAdmission",
) {}

export const make = Effect.gen(function* () {
	const db = yield* Db.make
	const store = yield* Store
	const origins = yield* ToolOrigins.make
	const delegations = yield* Delegations
	const requests = yield* Requests
	const metering = yield* DelegationUsage.make
	const permits = Effect.fn("WorkAdmission.permits")(function* (key: Key) {
		let current: Key | undefined = key
		let seen = HashSet.empty<Execution.Id>()
		let result: ReadonlyArray<Permit> = []
		while (current !== undefined) {
			if (HashSet.has(seen, current.id))
				return yield* Execution.Forbidden.make({})
			seen = HashSet.add(seen, current.id)
			let execution: Effect.Success<ReturnType<typeof store.loadMember>> =
				yield* store.loadMember(current)
			if (execution.record.resource.kind !== "Turn") {
				const origin: Effect.Success<ReturnType<typeof origins.find>> =
					yield* origins.find(current)
				if (Option.isSome(origin)) {
					current = origin.value.key
					if (HashSet.has(seen, current.id))
						return yield* Execution.Forbidden.make({})
					seen = HashSet.add(seen, current.id)
					execution = origin.value.execution
				}
			}
			const organizationId = execution.identity.owner.organizationId
			if (execution.record.resource.kind === "Turn") {
				const { host } = yield* Schema.decodeUnknownEffect(TurnReference)(
					execution.input,
				)
				if (host?.kind === "review" && host.review !== undefined) {
					const rows = yield* db
						.select({ namespace: executions.namespace, id: executions.id })
						.from(executions)
						.where(
							and(
								eq(executions.organizationId, organizationId),
								eq(executions.workflow, "openbot.capability-request"),
								eq(executions.resourceKind, "Request"),
								eq(executions.resourceId, host.review),
							),
						)
						.limit(2)
					const row = Arr.head(rows)
					if (rows.length !== 1 || Option.isNone(row))
						return yield* Execution.Forbidden.make({})
					const requestKey: Key = {
						namespace: row.value.namespace,
						id: Execution.Id.make(row.value.id),
					}
					const request: Effect.Success<ReturnType<typeof store.loadMember>> =
						yield* store.loadMember(requestKey)
					const ref: typeof RequestReference.Type =
						yield* Schema.decodeUnknownEffect(RequestReference)(request.input)
					const found = yield* requests.find(organizationId, host.review)
					if (Option.isNone(found)) return yield* Execution.Forbidden.make({})
					const saved = found.value.request
					if (
						ref.control !== undefined &&
						saved.status === "pending" &&
						saved.expiresAt > (yield* Clock.currentTimeMillis) &&
						saved.approver._tag === "Bot" &&
						saved.approver.bot === host.bot &&
						request.identity.parentExecutionId ===
							ref.control.turnExecutionId &&
						execution.identity.parentExecutionId ===
							ref.control.turnExecutionId &&
						sameCaller(request.identity.actor, execution.identity.actor) &&
						(yield* store.ownership(requestKey)).ownerExecutionId === ref.source
					) {
						let cursor = 0
						let linked = false
						while (true) {
							const events = yield* store.events(requestKey, cursor)
							linked ||= Arr.some(
								events,
								(event) =>
									event.body._tag === "ChildExecution" &&
									event.body.executionId === current!.id &&
									event.body.step === `review:${saved.revision}`,
							)
							if (events.length < 128) break
							if (Arr.isReadonlyArrayNonEmpty(events))
								cursor = Arr.lastNonEmpty(events).sequence
						}
						if (linked)
							result = Arr.append(result, {
								source: ref.source,
								control: ref.control,
							})
					}
				}
			}
			current =
				execution.identity.parentExecutionId === undefined
					? undefined
					: yield* store.locate(
							execution.identity.parentExecutionId,
							organizationId,
						)
		}
		return result
	}, storage)
	const check: Admission.Check = (key, lock, call, intent) =>
		Effect.gen(function* () {
			const execution = yield* store.loadMember(key)
			const upcoming = call ?? intent
			const modelHost =
				upcoming !== undefined &&
				execution.workflow === "openbot.chat-turn" &&
				Schema.is(Schema.Struct({ purpose: Schema.Literal("turn") }))(
					upcoming.input,
				)
					? (yield* Schema.decodeUnknownEffect(TurnReference)(execution.input))
							.host
					: undefined
			let current = key
			let seen = HashSet.make(key.id)
			let owners: ReadonlyArray<Key> = []
			while (true) {
				const { ownerExecutionId } = yield* store.ownership(current)
				if (ownerExecutionId === undefined) break
				if (HashSet.has(seen, ownerExecutionId))
					return yield* Execution.Forbidden.make({})
				seen = HashSet.add(seen, ownerExecutionId)
				current = yield* store.locate(
					ownerExecutionId,
					execution.identity.owner.organizationId,
				)
				owners = Arr.prepend(owners, current)
			}
			if (owners.length === 0) return
			if (lock) yield* Effect.forEach(owners, store.hold, { discard: true })
			let allowed: ReadonlyArray<Permit> | undefined
			for (const owner of owners) {
				// Read the event cursor before the domain row. A resume between these reads cannot be lost.
				const state = yield* store.loadMember(owner)
				if (state.record.status === "cancelling" || state.phaseFailed)
					return yield* Admission.Paused.make({
						...owner,
						afterSequence: state.record.sequence,
					})
				if (Execution.isTerminal(state.record.status))
					return yield* Execution.Conflict.make({ id: key.id })
				if (state.record.resource.kind !== "Delegation") continue
				const found = yield* delegations.find(
					state.identity.owner.organizationId,
					state.record.resource.id,
				)
				if (Option.isNone(found) || found.value.executionId !== owner.id)
					return yield* Execution.Forbidden.make({})
				const saved = found.value
				if (saved.delegation.status !== "paused") {
					const limits = saved.delegation.limits
					if (saved.delegation.status !== "running" || limits === undefined)
						continue
					const nextModel =
						modelHost?.kind === "task" &&
						modelHost.ownerExecutionId === owner.id &&
						(yield* store.ownership(key)).ownerExecutionId === owner.id
					const reached = Domain.reached(
						nextModel ? limits : Struct.omit(limits, ["steps"]),
						yield* nextModel && call !== undefined
							? metering.beforeCall(owner, call.id)
							: metering.read(owner),
						saved.window ?? noUsage,
					)
					if (Option.isNone(reached)) continue
					return yield* Admission.Paused.make({
						...owner,
						afterSequence: state.record.sequence,
						wake: `limit:${saved.limitEpoch ?? 0}:${reached.value}`,
					})
				}
				allowed ??= yield* permits(key)
				if (
					Arr.some(
						allowed,
						(permit) =>
							permit.source === owner.id &&
							permit.control.epoch === saved.limitEpoch &&
							permit.control.turnExecutionId === saved.limitTurnExecutionId,
					)
				)
					continue
				return yield* Admission.Paused.make({
					...owner,
					afterSequence: state.record.sequence,
				})
			}
		}).pipe(storage)
	return WorkAdmission.of({ check })
})

export const layer = Layer.effect(WorkAdmission, make)
