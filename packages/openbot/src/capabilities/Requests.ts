import { type AppCalls } from "@openbot-build/domain"
import { Settings } from "../settings/Settings.ts"
import type { Chat, Turn } from "@openbot-build/core"
import { Requests as RequestDomain } from "@openbot-build/domain"
import { CodeRuns as CodeDomain } from "@openbot-build/domain"
import { Bots as BotsApi } from "@openbot-build/domain"
import {
	Array as Arr,
	Cause,
	Clock,
	Context,
	Crypto,
	Effect,
	Layer,
	Option,
	pipe,
	Schema,
	String as Str,
} from "effect"
import { BotRecords } from "../bots/BotRecords.ts"
import { Chain } from "../chats/ChatHost.ts"
import { Grants } from "./Grants.ts"
import { Rules, deciderKey } from "./Rules.ts"
import * as Report from "../errors/Report.ts"
import type { Records } from "../errors/Records.ts"

type Request = RequestDomain.CapabilityRequest
type Approver = Request["approver"]

/**
 * A request as it is stored: the public record and the delegation chain it came through.
 * The deciders are the owner chain in `request.chain`.
 * `call` is the tool call that waits for the request. When the request is allowed,
 * OpenBot gives it back to the Chat, and the call runs then.
 */
export const Stored = Schema.Struct({
	request: RequestDomain.CapabilityRequest,
	chain: Chain,
	/** The Grant kept for the exact call that this request allows. */
	approvalGrant: Schema.optionalKey(BotsApi.GrantId),
	call: Schema.optionalKey(
		Schema.Struct({
			name: Schema.String,
			params: Schema.Json,
			/** The source of a host action, such as an action of an App view. */
			source: Schema.optionalKey(Schema.JsonObject),
		}),
	),
})
export type Stored = typeof Stored.Type

/**
 * The decider above a Bot in its owner chain: the Bot before it,
 * or the person at the top.
 */
export const superior = ({
	deciders,
	userId,
	bot,
}: {
	readonly deciders: ReadonlyArray<BotsApi.BotId>
	readonly userId: string
	readonly bot: BotsApi.BotId
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

const above = (stored: Stored, bot: BotsApi.BotId) =>
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
	readonly bot: BotsApi.BotId
	readonly current: Chat.Id
}): Chat.Id =>
	pipe(
		Arr.zip(chain.bots, Arr.append(chain.chats, current)),
		Arr.findLast(([id]) => id === bot),
		Option.map(([, chat]) => chat),
		Option.getOrElse(() => current),
	)

export interface Decision {
	readonly by: BotsApi.Decider
	readonly allow: boolean
	readonly scope?: BotsApi.GrantScope
	readonly reason?: string
	readonly question?: string
	readonly expected?: number
	/** For an allow by a Bot: true when the Bot holds the capability itself. */
	readonly holds?: boolean
	/** Keep the decision as a Rule for the requesting Bot. */
	readonly rule?: string
}

/**
 * How one request waits. `person` sends it to the person at once, not to the Bot above.
 * `timeoutMs` replaces the timeout of the organization. `onExpire` says what happens when
 * nobody answers in time. Without it, the request is denied.
 */
export interface Ask {
	readonly person?: boolean
	readonly timeoutMs?: number
	readonly onExpire?: "allow" | "deny"
}

/** The result of a decision: the request is final, or it went up to the next decider. */
export type Outcome =
	| { readonly _tag: "Final"; readonly stored: Stored }
	| { readonly _tag: "Escalated"; readonly stored: Stored }

/**
 * Requests of Bots for capabilities. A request waits for one decider at a time.
 * This service only keeps records. The coordinator starts reviews and lets the work go on.
 */
export class Requests extends Context.Service<
	Requests,
	{
		readonly create: (
			organizationId: string,
			input: {
				readonly bot: BotsApi.BotId
				readonly chain: Chain
				/** The owner chain of the Bot, from the top, ending with the Bot. */
				readonly deciders: ReadonlyArray<BotsApi.BotId>
				readonly capability: BotsApi.Capability
				readonly reason: string
				readonly chat: Chat.Id
				readonly turn: Turn.Id
				readonly toolCallId: string
				readonly app?: AppCalls.Invocation
				readonly code?: CodeDomain.RequestCode
				readonly ask?: Ask
				readonly call?: NonNullable<Stored["call"]>
				/** A request that is decided at once, for example by a Grant or by policy. */
				readonly decided?: {
					readonly allow: boolean
					readonly by: BotsApi.Decider
					readonly reason?: string
				}
			},
		) => Effect.Effect<Stored, BotsApi.BotStorageUnavailable>
		readonly find: (
			organizationId: string,
			id: string,
		) => Effect.Effect<Option.Option<Stored>, BotsApi.BotStorageUnavailable>
		/** The requests that wait for a person, or that the person decided. */
		readonly forPerson: (
			organizationId: string,
			userId: string,
			status?: Request["status"],
		) => Effect.Effect<ReadonlyArray<Request>, BotsApi.BotStorageUnavailable>
		/** The requests of one Chat. */
		readonly forChat: (
			organizationId: string,
			chat: Chat.Id,
		) => Effect.Effect<ReadonlyArray<Stored>, BotsApi.BotStorageUnavailable>
		readonly decide: (
			organizationId: string,
			id: string,
			decision: Decision,
		) => Effect.Effect<
			Outcome,
			| RequestDomain.RequestNotFound
			| RequestDomain.RequestConflict
			| BotsApi.BotStorageUnavailable
		>
		/**
		 * Sends a pending request to the next decider without support, for example when a
		 * review ended without a decision.
		 */
		readonly pass: (
			organizationId: string,
			id: string,
			from: BotsApi.BotId,
		) => Effect.Effect<Option.Option<Stored>, BotsApi.BotStorageUnavailable>
		/** Closes one pending request when its time is over. */
		readonly expireOne: (
			organizationId: string,
			id: string,
		) => Effect.Effect<Option.Option<Stored>, BotsApi.BotStorageUnavailable>
		/** Closes one request after its execution releases its resources. */
		readonly cancelOne: (
			organizationId: string,
			id: string,
			reason?: string,
		) => Effect.Effect<Option.Option<Stored>, BotsApi.BotStorageUnavailable>
	}
>()("@openbot-build/openbot/capabilities/Requests") {}

/** How long a request waits before it is denied, when the settings cannot be read. */
export const defaultTimeout = 24 * 60 * 60 * 1000

export const make: Effect.Effect<
	typeof Requests.Service,
	never,
	BotRecords | Grants | Rules | Settings | Crypto.Crypto | Records
> = Effect.gen(function* () {
	const settings = yield* Settings
	const report = yield* Report.make
	const records = yield* BotRecords
	const crypto = yield* Crypto.Crypto
	const newId = crypto
		.randomUUIDv7()
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
						request: RequestDomain.CapabilityRequestId.make(id),
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
						id: RequestDomain.CapabilityRequestId.make("req_" + (yield* newId)),
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
