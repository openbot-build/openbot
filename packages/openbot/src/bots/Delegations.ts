import type { Session, Turn } from "@openbot-build/core"
import { BotsApi } from "@openbot-build/api"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { hash } from "../capabilities/Capability.ts"
import { BotRecords } from "./BotRecords.ts"

type Delegation = BotsApi.Delegation

/** A delegation as it is stored, with the member it works for and its open request. */
export const Stored = Schema.Struct({
	delegation: BotsApi.Delegation,
	userId: Schema.String,
	/** The queued message, when the child Session was busy. Its Turn is the work. */
	queuedItem: Schema.optionalKey(Schema.String),
})
export type Stored = typeof Stored.Type

/** The records of work that one Bot gave to another. */
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
				readonly bot: BotsApi.BotId
				readonly brief: BotsApi.Brief
				readonly status: "authorizing" | "queued" | "failed"
				readonly result?: BotsApi.DelegationResult
			},
		) => Effect.Effect<Stored, BotsApi.BotStorageUnavailable>
		readonly forCall: (
			organizationId: string,
			session: Session.Id,
			toolCallId: string,
		) => Effect.Effect<Option.Option<Stored>, BotsApi.BotStorageUnavailable>
		readonly forSession: (
			organizationId: string,
			session: Session.Id,
		) => Effect.Effect<ReadonlyArray<Stored>, BotsApi.BotStorageUnavailable>
		/** The running delegation whose work happens in this Session. */
		readonly forChild: (
			organizationId: string,
			userId: string,
			session: Session.Id,
		) => Effect.Effect<Option.Option<Stored>, BotsApi.BotStorageUnavailable>
		/** Delegations that are not closed, in every organization. */
		readonly open: Effect.Effect<
			ReadonlyArray<{
				readonly organizationId: string
				readonly value: Stored
			}>,
			BotsApi.BotStorageUnavailable
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
		) => Effect.Effect<Option.Option<Stored>, BotsApi.BotStorageUnavailable>
	}
>()("@openbot-build/openbot/bots/Delegations") {}

export const make: Effect.Effect<
	typeof Delegations.Service,
	never,
	BotRecords
> = Effect.gen(function* () {
	const records = yield* BotRecords
	const delegations = records.collection(
		"delegation",
		Stored,
		BotsApi.DelegationStatus,
	)
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
							bot: input.bot,
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
				BotsApi.OpenDelegationStatus.literals,
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
