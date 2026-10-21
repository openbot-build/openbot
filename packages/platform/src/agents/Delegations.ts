import type { Session, Turn } from "@openbot-build/core"
import { AgentsApi } from "@openbot-build/platform-api"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { hash } from "../capabilities/Capability.ts"
import { AgentRecords } from "./AgentRecords.ts"

type Delegation = AgentsApi.Delegation

/** A delegation as it is stored, with the member it works for and its open request. */
export const Stored = Schema.Struct({
	delegation: AgentsApi.Delegation,
	userId: Schema.String,
	/** The queued message, when the child Session was busy. Its Turn is the work. */
	queuedItem: Schema.optionalKey(Schema.String),
})
export type Stored = typeof Stored.Type

/** The records of work that one Agent gave to another. */
export class Delegations extends Context.Service<
	Delegations,
	{
		/** Records a delegation for a tool call. A second call for the same tool call returns the first. */
		readonly propose: (
			organizationId: string,
			input: {
				readonly userId: string
				readonly parent: {
					readonly session: Session.Id
					readonly turn: Turn.Id
					readonly toolCallId: string
				}
				readonly agent: AgentsApi.AgentId
				readonly brief: AgentsApi.Brief
				readonly status: "authorizing" | "queued" | "failed"
				readonly result?: AgentsApi.DelegationResult
			},
		) => Effect.Effect<Stored, AgentsApi.AgentStorageUnavailable>
		readonly forCall: (
			organizationId: string,
			session: Session.Id,
			toolCallId: string,
		) => Effect.Effect<Option.Option<Stored>, AgentsApi.AgentStorageUnavailable>
		readonly forSession: (
			organizationId: string,
			session: Session.Id,
		) => Effect.Effect<ReadonlyArray<Stored>, AgentsApi.AgentStorageUnavailable>
		/** The running delegation whose work happens in this Session. */
		readonly forChild: (
			organizationId: string,
			userId: string,
			session: Session.Id,
		) => Effect.Effect<Option.Option<Stored>, AgentsApi.AgentStorageUnavailable>
		/** Delegations that are not closed, in every organization. */
		readonly open: Effect.Effect<
			ReadonlyArray<{
				readonly organizationId: string
				readonly value: Stored
			}>,
			AgentsApi.AgentStorageUnavailable
		>
		/**
		 * Changes a delegation when it still has one of the expected statuses.
		 * Returns None when it does not, so two workers never do the same step.
		 */
		readonly change: (
			organizationId: string,
			id: string,
			expected: ReadonlyArray<Delegation["status"]>,
			update: (stored: Stored) => Stored,
		) => Effect.Effect<Option.Option<Stored>, AgentsApi.AgentStorageUnavailable>
	}
>()("@openbot-build/platform/agents/Delegations") {}

export const make: Effect.Effect<
	typeof Delegations.Service,
	never,
	AgentRecords
> = Effect.gen(function* () {
	const records = yield* AgentRecords
	const delegations = records.collection("delegation", Stored)
	const put = (organizationId: string, stored: Stored) =>
		delegations
			.put(
				{
					organizationId,
					id: stored.delegation.id,
					owner: stored.userId,
					scope: stored.delegation.parent.session,
					status: stored.delegation.status,
				},
				stored,
			)
			.pipe(Effect.as(stored))
	const idFor = (session: Session.Id, toolCallId: string) =>
		"dlg_" + hash([session, toolCallId])
	return Delegations.of({
		propose: (organizationId, input) =>
			records.transaction(
				"delegation:" + organizationId + ":" + input.parent.session,
				Effect.gen(function* () {
					const id = idFor(input.parent.session, input.parent.toolCallId)
					const existing = yield* delegations.find(organizationId, id)
					if (Option.isSome(existing)) return existing.value
					const now = yield* Clock.currentTimeMillis
					return yield* put(organizationId, {
						userId: input.userId,
						delegation: {
							id,
							parent: input.parent,
							agent: input.agent,
							child: null,
							status: input.status,
							brief: input.brief,
							result: input.result ?? null,
							createdAt: now,
							updatedAt: now,
						},
					})
				}),
			),
		forCall: (organizationId, session, toolCallId) =>
			delegations.find(organizationId, idFor(session, toolCallId)),
		forSession: (organizationId, session) =>
			delegations.list(organizationId, { scope: session }),
		forChild: (organizationId, userId, session) =>
			delegations
				.list(organizationId, { owner: userId, status: "running" })
				.pipe(
					Effect.map((list) =>
						Option.fromNullishOr(
							list.find(
								(stored) => stored.delegation.child?.session === session,
							),
						),
					),
				),
		open: Effect.gen(function* () {
			const all = yield* Effect.forEach(
				["authorizing", "queued", "running"],
				(status) => delegations.withStatus(status),
			)
			return all.flat()
		}),
		change: (organizationId, id, expected, update) =>
			records.transaction(
				"delegation-item:" + organizationId + ":" + id,
				Effect.gen(function* () {
					const found = yield* delegations.find(organizationId, id)
					if (
						Option.isNone(found) ||
						!expected.includes(found.value.delegation.status)
					)
						return Option.none()
					const now = yield* Clock.currentTimeMillis
					const next = update(found.value)
					return Option.some(
						yield* put(organizationId, {
							...next,
							delegation: { ...next.delegation, updatedAt: now },
						}),
					)
				}),
			),
	})
})
export const layer = Layer.effect(Delegations, make)
