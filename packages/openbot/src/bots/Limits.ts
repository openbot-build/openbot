import type { Chat } from "@openbot-build/core"
import type { BotsApi, DelegationsApi } from "@openbot-build/api"
import {
	Array as Arr,
	Cause,
	Clock,
	Context,
	Effect,
	HashSet,
	Layer,
	Option,
} from "effect"
import * as Background from "../app/Background.ts"
import { Billing } from "../billing/Billing.ts"
import { type Answer, Gate } from "../capabilities/Gate.ts"
import { delegationTimeLimitOf } from "../settings/Documents.ts"
import { Settings } from "../settings/Settings.ts"
import { Delegations, noUsage, type Stored, usageOf } from "./Delegations.ts"

type Limit = DelegationsApi.DelegationLimit

/** What the check of the limits of some work found. */
export interface Check {
	/** The first limit that the work reached, when it reached one. */
	readonly reached: Option.Option<Limit>
	/** What the work used up to now, with its cost when the work has a budget. */
	readonly usage: DelegationsApi.DelegationUsage
}

/**
 * The limits of delegated work: time, model steps and budget. The time limit is
 * required. Work from before limits, and the work of a trigger, use the time limit of
 * the organization.
 */
export class Limits extends Context.Service<
	Limits,
	{
		/** The limits of the work. */
		readonly of: (
			organizationId: string,
			stored: Stored,
		) => Effect.Effect<DelegationsApi.DelegationLimits>
		/** What the model calls of the work, and of all the work it gave away, cost since it started. */
		readonly cost: (
			organizationId: string,
			stored: Stored,
		) => Effect.Effect<number>
		readonly check: (
			organizationId: string,
			stored: Stored,
			now: number,
		) => Effect.Effect<Check>
		/**
		 * Pauses running work at a limit, and asks the decider above its Bot whether it
		 * goes on. The current Work must be the Work of its task Chat. When the answer is
		 * `Allow`, the work runs again at once with new limits. None means that the work
		 * did not run, so another worker paused or ended it.
		 */
		readonly pause: (
			organizationId: string,
			id: string,
			limit: Limit,
		) => Effect.Effect<Option.Option<Answer>, BotsApi.BotStorageUnavailable>
	}
>()("@openbot-build/openbot/bots/Limits") {}

/** The usage at the time the limits last started. */
export const windowOf = (stored: Stored) => stored.window ?? noUsage

/** The work as paused at a limit. Its running time stops. */
export const paused = (
	stored: Stored,
	input: {
		readonly limit: Limit
		readonly now: number
		/** The work above whose limit was reached, when it was not this work. */
		readonly delegation?: string
		readonly request?: string | null
	},
): Stored => {
	const { runningSince: _since, ...rest } = stored
	return {
		...rest,
		delegation: {
			...stored.delegation,
			status: "paused",
			usage: usageOf(stored, input.now),
			pause: {
				limit: input.limit,
				request: input.request ?? null,
				...(input.delegation === undefined
					? {}
					: { delegation: input.delegation }),
				at: input.now,
			},
		},
	}
}

/**
 * The work as running again. With `renew`, its limits start again from what it used
 * up to now. Work that only waited for the work above it keeps its limits.
 */
export const resumed = (
	stored: Stored,
	input: {
		readonly now: number
		readonly renew: boolean
		readonly costMicros: number
	},
): Stored => {
	const { pause: _pause, ...delegation } = stored.delegation
	const usage = {
		...(delegation.usage ?? noUsage),
		costMicros: input.costMicros,
	}
	return {
		...stored,
		...(input.renew ? { window: usage } : {}),
		runningSince: input.now,
		delegation: { ...delegation, status: "running", usage },
	}
}

/** Why the work asks to go on, for the decider. */
const reasonOf = (limit: Limit, limits: DelegationsApi.DelegationLimits) =>
	limit === "time"
		? `The work ran for its time limit of ${Math.round(limits.timeMs / 60000)} minutes and wants more time.`
		: limit === "steps"
			? `The work used its limit of ${limits.steps} model steps and wants more steps.`
			: `The work used its budget of ${(limits.budgetMicros ?? 0) / 1_000_000} US dollars and wants more money.`

export const make: Effect.Effect<
	typeof Limits.Service,
	never,
	Delegations | Settings | Gate | Billing
> = Effect.gen(function* () {
	const delegations = yield* Delegations
	const settings = yield* Settings
	const gate = yield* Gate
	const billing = yield* Billing
	const of: typeof Limits.Service.of = (organizationId, stored) =>
		stored.delegation.limits !== undefined
			? Effect.succeed(stored.delegation.limits)
			: settings.organization(organizationId).pipe(
					Effect.map((current) => delegationTimeLimitOf(current.document)),
					// Work must have a time limit, so it gets the default one.
					Effect.catch((error) =>
						Effect.logWarning(
							"The time limit of the organization could not be read, so work uses the default one",
							error,
						).pipe(Effect.as(delegationTimeLimitOf({}))),
					),
					Effect.map((timeMs) => ({ timeMs })),
				)
	/** The task Chats of the work and of all the work below it. */
	const chatsBelow = (
		organizationId: string,
		chat: Chat.Id,
	): Effect.Effect<HashSet.HashSet<Chat.Id>, BotsApi.BotStorageUnavailable> =>
		Effect.gen(function* () {
			let found = HashSet.make(chat)
			let next: ReadonlyArray<Chat.Id> = [chat]
			while (next.length > 0) {
				const given = yield* Effect.forEach(next, (parent) =>
					delegations.forChat(organizationId, parent),
				)
				next = Arr.flatMap(Arr.flatten(given), (child) =>
					child.delegation.chat === null ||
					HashSet.has(found, child.delegation.chat)
						? []
						: [child.delegation.chat],
				)
				found = HashSet.union(found, HashSet.fromIterable(next))
			}
			return found
		})
	const cost: typeof Limits.Service.cost = (organizationId, stored) =>
		Effect.gen(function* () {
			const chat = stored.delegation.chat
			if (chat === null) return 0
			const chats = yield* chatsBelow(organizationId, chat)
			return yield* billing.chatSpend(
				organizationId,
				[...chats],
				stored.delegation.createdAt,
			)
		}).pipe(
			// The last known cost is better than none. A stop is not a failure.
			Effect.catchCause((cause) =>
				Cause.hasInterruptsOnly(cause)
					? Effect.interrupt
					: Effect.logWarning(
							"The cost of delegated work could not be read",
							cause,
						).pipe(Effect.as(stored.delegation.usage?.costMicros ?? 0)),
			),
		)
	const check: typeof Limits.Service.check = (organizationId, stored, now) =>
		Effect.gen(function* () {
			const limits = yield* of(organizationId, stored)
			const window = windowOf(stored)
			const current = usageOf(stored, now)
			const usage =
				limits.budgetMicros === undefined
					? current
					: { ...current, costMicros: yield* cost(organizationId, stored) }
			const reached: Option.Option<Limit> =
				usage.timeMs - window.timeMs >= limits.timeMs
					? Option.some("time")
					: limits.steps !== undefined &&
						  usage.steps - window.steps >= limits.steps
						? Option.some("steps")
						: limits.budgetMicros !== undefined &&
							  usage.costMicros - window.costMicros >= limits.budgetMicros
							? Option.some("budget")
							: Option.none()
			return { reached, usage }
		})
	/**
	 * Work that paused but has no answer yet. Nothing else sets it running again, so
	 * `pause` uses this when its check ends without an answer.
	 */
	const unanswered = (stored: Stored) =>
		stored.delegation.pause?.request === null &&
		stored.delegation.pause.delegation === undefined
	/**
	 * Lets paused work run again with the limits it had, because its check of the
	 * Gate stopped before an answer. The next check of its limits pauses it again.
	 */
	const unpause = (organizationId: string, id: string) =>
		Clock.currentTimeMillis.pipe(
			Effect.flatMap((now) =>
				delegations.change(
					organizationId,
					id,
					["paused"],
					(stored) =>
						resumed(stored, {
							now,
							renew: false,
							costMicros: stored.delegation.usage?.costMicros ?? 0,
						}),
					unanswered,
				),
			),
			Background.logFailure(
				"Work that stopped while it paused could not run again",
			),
		)
	// A pause must not stop halfway. Work that is paused with no request stays paused
	// for ever, because nothing else lets it run again. So the writes of a pause are
	// not cut. Only the slow check of the Gate can be cut (the judge model can take
	// seconds), for example when a person stops the Turn or the server shuts down.
	// Then the work runs again in place of the pause.
	const pause: typeof Limits.Service.pause = (organizationId, id, limit) =>
		Effect.uninterruptibleMask((restore) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				const stopped = yield* delegations.change(
					organizationId,
					id,
					["running"],
					(stored) => paused(stored, { limit, now }),
				)
				if (Option.isNone(stopped)) return Option.none()
				const { answer, costMicros } = yield* restore(
					Effect.gen(function* () {
						const limits = yield* of(organizationId, stopped.value)
						const answer = yield* gate.check({
							capability: {
								action: "delegations.continue",
								target: id,
								arguments: { limit },
							},
							reason: reasonOf(limit, limits),
							toolCallId: "limit:" + id + ":" + now,
						})
						return {
							answer,
							costMicros:
								answer._tag === "Allow"
									? yield* cost(organizationId, stopped.value)
									: 0,
						}
					}),
				).pipe(Effect.onError(() => unpause(organizationId, id)))
				if (answer._tag === "Allow") {
					yield* delegations.change(organizationId, id, ["paused"], (stored) =>
						resumed(stored, { now, renew: true, costMicros }),
					)
				} else if (answer.request !== undefined) {
					const request = answer.request
					// A decision can come before this, and then the work runs again already.
					yield* delegations.change(
						organizationId,
						id,
						["paused"],
						(stored) => ({
							...stored,
							delegation: {
								...stored.delegation,
								pause: { ...stored.delegation.pause!, request },
							},
						}),
						(stored) => stored.delegation.pause?.request === null,
					)
				}
				return Option.some(answer)
			}),
		)
	return Limits.of({ of, cost, check, pause })
})
export const layer = Layer.effect(Limits, make)
