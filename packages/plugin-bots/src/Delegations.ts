import { Delegations as DelegationDomain } from "@openbot-build/domain"
import {
	Array as Arr,
	Clock,
	Effect,
	Layer,
	Option,
	Order,
	pipe,
	Schema,
} from "effect"
import { Digest, SecureRandom } from "effect/crypto"
import { Hex } from "effect/encoding"
import { hash } from "@openbot-build/conversation-contract/capabilities/Capability"
import { BotRecords } from "@openbot-build/conversation-contract/bots/BotRecords"
import {
	type Delegation,
	Stored,
	type CreateInput,
	Delegations,
	noUsage,
} from "@openbot-build/conversation-contract/bots/Delegations"
export {
	Stored,
	Delegations,
	noUsage,
} from "@openbot-build/conversation-contract/bots/Delegations"
export type { CreateInput } from "@openbot-build/conversation-contract/bots/Delegations"

/** What the work used, with the running time up to now. */
export const usageOf = (
	stored: Stored,
	now: number,
): DelegationDomain.DelegationUsage => {
	const usage = stored.delegation.usage ?? noUsage
	return stored.runningSince === undefined
		? usage
		: {
				...usage,
				timeMs: usage.timeMs + Math.max(0, now - stored.runningSince),
			}
}

/** The delegation as people see it, with the running time up to now. */
export const view = (stored: Stored, now: number): Delegation =>
	stored.delegation.usage === undefined
		? stored.delegation
		: { ...stored.delegation, usage: usageOf(stored, now) }

const isOpenStatus = Schema.is(DelegationDomain.OpenDelegationStatus)

/** True when the work has not ended yet. */
export const isOpen = (stored: Stored) => isOpenStatus(stored.delegation.status)

const byCreation = Order.mapInput(
	Order.Number,
	(stored: Stored) => stored.delegation.createdAt,
)

export const make: Effect.Effect<
	typeof Delegations.Service,
	never,
	BotRecords | SecureRandom.SecureRandom | Digest.Digest
> = Effect.gen(function* () {
	const records = yield* BotRecords
	const crypto = yield* SecureRandom.SecureRandom
	const hashes = yield* Digest.Digest
	const delegations = records.collection(
		"delegation",
		Stored,
		DelegationDomain.DelegationStatus,
	)
	const put = (organizationId: string, stored: Stored) =>
		delegations
			.put(
				{
					organizationId,
					id: stored.delegation.id,
					owner: stored.userId,
					scope: stored.delegation.parent.chat,
					status: stored.delegation.status,
				},
				stored,
			)
			.pipe(Effect.as(stored))
	const idFor = (input: CreateInput) =>
		input.id !== undefined
			? Effect.succeed(input.id)
			: input.parent.toolCallId === undefined
				? crypto.uuidV7({ format: "bytes" }).pipe(
						// A platform without secure random numbers is broken.
						Effect.orDie,
						Effect.map((uuid) => "dlg_" + Hex.encode(uuid)),
					)
				: Effect.map(
						hash(hashes, [input.parent.chat, input.parent.toolCallId]),
						(value) => "dlg_" + value,
					)
	return Delegations.of({
		create: (organizationId, input) =>
			records.transaction(
				"delegation:" + organizationId + ":" + input.parent.chat,
				Effect.gen(function* () {
					const id = yield* idFor(input)
					const existing = yield* delegations.find(organizationId, id)
					if (Option.isSome(existing)) return existing.value
					const now = yield* Clock.currentTimeMillis
					return yield* put(organizationId, {
						...(input.executionId === undefined
							? {}
							: { executionId: input.executionId }),
						userId: input.userId,
						author: input.author,
						chain: input.chain,
						...(input.request === undefined ? {} : { request: input.request }),
						...(input.runningSince === undefined
							? {}
							: { runningSince: input.runningSince }),
						delegation: {
							id: DelegationDomain.DelegationId.make(id),
							parent: input.parent,
							...(input.trigger === undefined
								? {}
								: { trigger: input.trigger }),
							bot: input.bot,
							chat: input.chat ?? null,
							status: input.status,
							task: input.task,
							...(input.reason === undefined ? {} : { reason: input.reason }),
							result: input.result ?? null,
							...(input.limits === undefined
								? {}
								: { limits: input.limits, usage: noUsage }),
							createdAt: now,
							updatedAt: now,
						},
					})
				}),
			),
		find: (organizationId, id) => delegations.find(organizationId, id),
		forChat: (organizationId, chat) =>
			delegations.list(organizationId, { scope: chat }),
		forChild: (organizationId, userId, chat) =>
			delegations.list(organizationId, { owner: userId }).pipe(
				Effect.map((list) =>
					pipe(
						list,
						Arr.filter((stored) => stored.delegation.chat === chat),
						Arr.sort(byCreation),
					),
				),
			),
		forRequest: (organizationId, chat, request) =>
			delegations
				.list(organizationId, { scope: chat })
				.pipe(
					Effect.map((list) =>
						Arr.findFirst(list, (stored) => stored.request === request),
					),
				),
		change: (organizationId, id, expected, update, when) =>
			records.transaction(
				"delegation-item:" + organizationId + ":" + id,
				Effect.gen(function* () {
					const found = yield* delegations.find(organizationId, id)
					if (
						Option.isNone(found) ||
						!Arr.contains(expected, found.value.delegation.status) ||
						(when !== undefined && !when(found.value))
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
