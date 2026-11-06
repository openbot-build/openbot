import type { BotId } from "@openbot-build/domain/BotId"
import { CapabilityRequestId } from "@openbot-build/domain/CapabilityRequestId"
import { Settings } from "@openbot-build/server-kernel/Settings"
import type { Chat } from "@openbot-build/core"
import { Requests as RequestDomain } from "@openbot-build/domain"
import { Bots as BotsApi } from "@openbot-build/domain"
import {
	Array as Arr,
	Cause,
	Clock,
	Effect,
	Layer,
	Option,
	pipe,
	String as Str,
} from "effect"
import { SecureRandom } from "effect/crypto"
import { BotRecords } from "@openbot-build/conversation-contract/bots/BotRecords"
import { Chain } from "@openbot-build/conversation-contract/chats/ChatHost"
import { Grants } from "@openbot-build/conversation-contract/capabilities/Grants"
import {
	Rules,
	deciderKey,
} from "@openbot-build/conversation-contract/capabilities/Rules"
import * as Report from "@openbot-build/server-kernel/Report"
import type { Records } from "@openbot-build/server-kernel/Records"
import {
	type Request,
	Stored,
	type Decision,
	Requests,
} from "@openbot-build/conversation-contract/capabilities/Requests"
type Approver = Request["approver"]

/**
 * The decider above a Bot in its owner chain: the Bot before it,
 * or the person at the top.
 */
export const superior = ({
	deciders,
	userId,
	bot,
}: {
	readonly deciders: ReadonlyArray<BotId>
	readonly userId: string
	readonly bot: BotId
}): Approver =>
	pipe(
		Arr.findFirstIndex(deciders, (id) => id === bot),
		Option.filter((index) => index > 0),
		Option.flatMap((index) => Arr.get(deciders, index - 1)),
		Option.match({
			onNone: (): Approver => ({ _tag: "Person", userId }),
			onSome: (bot): Approver => ({ _tag: "Bot", bot }),
		}),
	)

const above = (stored: Stored, bot: BotId) =>
	superior({
		deciders: stored.request.chain,
		userId: stored.chain.userId,
		bot,
	})

/**
 * The Chat where a Bot of the delegation chain works. The last Bot works in `current`.
 * A decider outside the delegation chain gets `current` too. A Bot can come more than
 * once, when it gave work to itself, so the nearest place counts.
 */
export const chatOf = ({
	chain,
	bot,
	current,
}: {
	readonly chain: Chain
	readonly bot: BotId
	readonly current: Chat.Id
}): Chat.Id =>
	pipe(
		Arr.zip(chain.bots, Arr.append(chain.chats, current)),
		Arr.findLast(([id]) => id === bot),
		Option.map(([, chat]) => chat),
		Option.getOrElse(() => current),
	)

/** How long a request waits before it is denied, when the settings cannot be read. */
export const defaultTimeout = 24 * 60 * 60 * 1000

export const make: Effect.Effect<
	typeof Requests.Service,
	never,
	BotRecords | Grants | Rules | Settings | SecureRandom.SecureRandom | Records
> = Effect.gen(function* () {
	const settings = yield* Settings
	const report = yield* Report.make
	const records = yield* BotRecords
	const crypto = yield* SecureRandom.SecureRandom
	const newId = crypto
		.uuidV7()
		.pipe(Effect.orDie, Effect.map(Str.replaceAll("-", "")))
	const grants = yield* Grants
	const rules = yield* Rules
	const requests = records.collection(
		"request",
		Stored,
		RequestDomain.RequestStatus,
	)
	/** Each organization says how long its requests wait. */
	const timeoutOf = (organizationId: string) =>
		settings.organization(organizationId).pipe(
			Effect.map((current) => current.document.requestTimeoutMs),
			// A request must have a time limit, so it gets the default one.
			Effect.tapCauseIf(Cause.hasFails, (cause) =>
				report(
					"The request timeout of the organization could not be read, so the request uses the default one",
					cause,
				),
			),
			Effect.orElseSucceed(() => defaultTimeout),
		)
	/**
	 * Runs a read-change-write step of one request in a transaction that holds the
	 * lock of the request, so two steps on the same request never run at the same time.
	 */
	const locked = <A, E, R>(
		organizationId: string,
		id: string,
		operation: Effect.Effect<A, E, R>,
	) => records.transaction("request:" + organizationId + ":" + id, operation)
	const put = (organizationId: string, stored: Stored) =>
		requests
			.put(
				{
					organizationId,
					id: stored.request.id,
					owner: deciderKey(stored.request.approver),
					scope: stored.request.chat,
					status: stored.request.status,
				},
				stored,
			)
			.pipe(Effect.as(stored))
	/** Gives the Grants down the chain, from the top decider to the requesting Bot. */
	const giveGrants = (
		organizationId: string,
		stored: Stored,
		final: Decision,
	) =>
		Effect.gen(function* () {
			const request = stored.request
			// Givers from the bottom: each endorsing Bot, then the final decider.
			const givers: ReadonlyArray<{
				readonly by: BotsApi.Decider
				readonly scope: BotsApi.GrantScope
				readonly reason?: string
			}> = [
				...Arr.map(request.endorsements, (entry) => ({
					by: { _tag: "Bot" as const, bot: entry.bot },
					scope: entry.scope,
					...(entry.reason === undefined ? {} : { reason: entry.reason }),
				})),
				{
					by: final.by,
					scope: final.scope ?? "once",
					...(final.reason === undefined ? {} : { reason: final.reason }),
				},
			]
			const receivers = [
				request.bot,
				...Arr.map(request.endorsements, (entry) => entry.bot),
			]
			// From the top down, so each Grant can name the Grant above it as its parent.
			return yield* Effect.reduce(
				Arr.reverse(Arr.zip(receivers, givers)),
				() => Option.none<BotsApi.GrantId>(),
				(parent, [bot, giver]) =>
					grants
						.create(
							organizationId,
							{
								bot,
								capability: request.capability,
								effect: "allow",
								scope: giver.scope,
								...(giver.scope === "chat"
									? {
											chat: chatOf({
												chain: stored.chain,
												bot,
												current: request.chat,
											}),
										}
									: {}),
								grantedBy: giver.by,
								...(giver.reason === undefined ? {} : { reason: giver.reason }),
								...Option.match(parent, {
									onNone: () => ({}),
									onSome: (parent) => ({ parent }),
								}),
							},
							// The call that waits uses a `once` decision when it runs.
							true,
						)
						.pipe(Effect.map((grant) => Option.some(grant.id))),
			)
		})
	const decide: typeof Requests.Service.decide = (
		organizationId,
		id,
		decision,
	) =>
		locked(
			organizationId,
			id,
			Effect.gen(function* () {
				const found = yield* requests.find(organizationId, id)
				if (Option.isNone(found))
					return yield* RequestDomain.RequestNotFound.make({
						request: CapabilityRequestId.make(id),
					})
				const stored = found.value
				const request = stored.request
				if (request.status !== "pending")
					return yield* RequestDomain.RequestConflict.make({
						message: "The request is already closed.",
					})
				if (
					decision.expected !== undefined &&
					decision.expected !== request.revision
				)
					return yield* RequestDomain.RequestConflict.make({
						message: "The request changed. Read it again and retry.",
					})
				if (deciderKey(decision.by) !== deciderKey(request.approver))
					return yield* RequestDomain.RequestConflict.make({
						message: "The request waits for another decider.",
					})
				const now = yield* Clock.currentTimeMillis
				if (request.expiresAt <= now)
					return yield* RequestDomain.RequestConflict.make({
						message: "The request has expired.",
					})
				if (decision.rule !== undefined)
					yield* rules.create(organizationId, {
						bot: request.bot,
						author: decision.by,
						text: decision.rule,
						status: decision.by._tag === "Person" ? "active" : "proposed",
					})
				// A Bot that agrees but does not hold the capability passes the request up.
				if (
					decision.allow &&
					decision.by._tag === "Bot" &&
					decision.holds !== true
				) {
					const bot = decision.by.bot
					return {
						_tag: "Escalated" as const,
						stored: yield* put(organizationId, {
							...stored,
							request: {
								...request,
								endorsements: [
									...request.endorsements,
									{
										bot,
										scope: decision.scope ?? "once",
										...(decision.reason === undefined
											? {}
											: { reason: decision.reason }),
									},
								],
								approver: above(stored, bot),
								revision: request.revision + 1,
							},
						}),
					}
				}
				const approvalGrant = decision.allow
					? yield* giveGrants(organizationId, stored, decision)
					: Option.none<BotsApi.GrantId>()
				if (
					!decision.allow &&
					decision.scope !== undefined &&
					decision.scope !== "once"
				)
					yield* grants.create(organizationId, {
						bot: request.bot,
						capability: request.capability,
						effect: "deny",
						scope: decision.scope,
						...(decision.scope === "chat" ? { chat: request.chat } : {}),
						grantedBy: decision.by,
						...(decision.reason === undefined
							? {}
							: { reason: decision.reason }),
					})
				return {
					_tag: "Final" as const,
					stored: yield* put(organizationId, {
						...stored,
						...(Option.isSome(approvalGrant)
							? { approvalGrant: approvalGrant.value }
							: {}),
						request: {
							...request,
							status: decision.allow ? "allowed" : "denied",
							decision: {
								by: decision.by,
								...(decision.scope === undefined
									? {}
									: { scope: decision.scope }),
								...(decision.reason === undefined
									? {}
									: { reason: decision.reason }),
								...(decision.question === undefined
									? {}
									: { question: decision.question }),
								at: now,
							},
							revision: request.revision + 1,
						},
					}),
				}
			}),
		)
	const close = (
		organizationId: string,
		stored: Stored,
		status: "expired" | "cancelled",
		now: number,
		reason?: string,
	) => {
		// Some requests say that silence means yes, such as a plan with `onTimeout: "run"`.
		const allow = status === "expired" && stored.request.onExpire === "allow"
		return put(organizationId, {
			...stored,
			request: {
				...stored.request,
				status: allow ? "allowed" : status,
				decision: {
					by: { _tag: "Person", userId: stored.chain.userId },
					reason:
						reason ??
						(allow
							? "Nobody answered the request in time, and the settings allow it then."
							: status === "expired"
								? "Nobody answered the request in time."
								: "The work was cancelled before the request was answered."),
					at: now,
				},
				revision: stored.request.revision + 1,
			},
		})
	}
	/**
	 * Closes one request under its lock, but only when it still waits. A request that
	 * was decided or closed in the meantime stays as it is. An expired request must also
	 * be over its time.
	 */
	const closePending = (
		organizationId: string,
		id: string,
		status: "expired" | "cancelled",
		reason?: string,
	) =>
		locked(
			organizationId,
			id,
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				const found = yield* requests.find(organizationId, id)
				if (
					Option.isNone(found) ||
					found.value.request.status !== "pending" ||
					(status === "expired" && found.value.request.expiresAt > now)
				)
					return Option.none()
				return Option.some(
					yield* close(organizationId, found.value, status, now, reason),
				)
			}),
		)
	const expireOne: typeof Requests.Service.expireOne = (organizationId, id) =>
		closePending(organizationId, id, "expired")
	return Requests.of({
		create: (organizationId, input) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				const timeout =
					input.ask?.timeoutMs ?? (yield* timeoutOf(organizationId))
				const status: Request["status"] =
					input.decided === undefined
						? "pending"
						: input.decided.allow
							? "allowed"
							: "denied"
				return yield* put(organizationId, {
					chain: input.chain,
					...(input.call === undefined ? {} : { call: input.call }),
					request: {
						id: CapabilityRequestId.make("req_" + (yield* newId)),
						bot: input.bot,
						capability: input.capability,
						reason: input.reason,
						approver:
							input.ask?.person === true
								? { _tag: "Person", userId: input.chain.userId }
								: superior({
										deciders: input.deciders,
										userId: input.chain.userId,
										bot: input.bot,
									}),
						chain: input.deciders,
						chat: input.chat,
						turn: input.turn,
						toolCallId: input.toolCallId,
						...(input.app === undefined ? {} : { app: input.app }),
						...(input.code === undefined ? {} : { code: input.code }),
						endorsements: [],
						status,
						decision:
							input.decided === undefined
								? null
								: {
										by: input.decided.by,
										...(input.decided.reason === undefined
											? {}
											: { reason: input.decided.reason }),
										at: now,
									},
						revision: 0,
						createdAt: now,
						expiresAt: now + timeout,
						...(input.ask?.onExpire === undefined
							? {}
							: { onExpire: input.ask.onExpire }),
					},
				})
			}),
		find: (organizationId, id) => requests.find(organizationId, id),
		forPerson: (organizationId, userId, status) =>
			requests
				.list(organizationId, {
					owner: deciderKey({ _tag: "Person", userId }),
					...(status === undefined ? {} : { status }),
				})
				.pipe(Effect.map(Arr.map((stored) => stored.request))),
		forChat: (organizationId, chat) =>
			requests.list(organizationId, { scope: chat }),
		decide,
		pass: (organizationId, id, from) =>
			locked(
				organizationId,
				id,
				Effect.gen(function* () {
					const found = yield* requests.find(organizationId, id)
					if (
						Option.isNone(found) ||
						found.value.request.status !== "pending" ||
						deciderKey(found.value.request.approver) !==
							deciderKey({ _tag: "Bot", bot: from })
					)
						return Option.none()
					const stored = found.value
					return Option.some(
						yield* put(organizationId, {
							...stored,
							request: {
								...stored.request,
								approver: above(stored, from),
								revision: stored.request.revision + 1,
							},
						}),
					)
				}),
			),
		expireOne,
		cancelOne: (organizationId, id, reason) =>
			closePending(organizationId, id, "cancelled", reason),
	})
})

export const layer = Layer.effect(Requests, make)
