import { Settings } from "../settings/Settings.ts"
import { randomUUID } from "node:crypto"
import type { Session, Turn } from "@openbot-build/core"
import {
	BotsApi,
	type AppExecution,
	type CodeRunsApi,
	RequestsApi,
} from "@openbot-build/api"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { BotRecords } from "../bots/BotRecords.ts"
import { Chain } from "../sessions/SessionHost.ts"
import { Grants } from "./Grants.ts"
import { Rules, deciderKey } from "./Rules.ts"

type Request = RequestsApi.CapabilityRequest
type Approver = Request["approver"]

/**
 * A request as it is stored: the public record and the delegation chain it came through.
 * The deciders are the owner chain in `request.chain`.
 */
export const Stored = Schema.Struct({
	request: RequestsApi.CapabilityRequest,
	chain: Chain,
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
	readonly bot: string
}): Approver => {
	const index = deciders.indexOf(bot as BotsApi.BotId)
	return index > 0
		? { _tag: "Bot", bot: deciders[index - 1]! }
		: { _tag: "Person", userId }
}

const above = (stored: Stored, bot: string) =>
	superior({
		deciders: stored.request.chain,
		userId: stored.chain.userId,
		bot,
	})

/**
 * The Session where a Bot of the delegation chain works. The last Bot works in `current`.
 * A decider outside the delegation chain gets `current` too.
 */
export const sessionOf = ({
	chain,
	bot,
	current,
}: {
	readonly chain: Chain
	readonly bot: string
	readonly current: Session.Id
}) => {
	const index = chain.bots.indexOf(bot as BotsApi.BotId)
	return index >= 0 && index < chain.sessions.length
		? chain.sessions[index]!
		: current
}

const approverKey = (approver: Approver) =>
	approver._tag === "Person"
		? "person:" + approver.userId
		: "bot:" + approver.bot

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
				readonly session: Session.Id
				readonly turn: Turn.Id
				readonly toolCallId: string
				readonly app?: AppExecution.Invocation
				readonly code?: CodeRunsApi.RequestCode
				readonly ask?: Ask
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
		/** The requests of one Session. */
		readonly forSession: (
			organizationId: string,
			session: Session.Id,
		) => Effect.Effect<ReadonlyArray<Stored>, BotsApi.BotStorageUnavailable>
		readonly pending: Effect.Effect<
			ReadonlyArray<{
				readonly organizationId: string
				readonly value: Stored
			}>,
			BotsApi.BotStorageUnavailable
		>
		readonly decide: (
			organizationId: string,
			id: string,
			decision: Decision,
		) => Effect.Effect<
			Outcome,
			| RequestsApi.RequestNotFound
			| RequestsApi.RequestConflict
			| BotsApi.BotStorageUnavailable
		>
		/** Closes pending requests whose time is over. Returns the closed requests. */
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
		readonly expire: Effect.Effect<
			ReadonlyArray<{
				readonly organizationId: string
				readonly value: Stored
			}>,
			BotsApi.BotStorageUnavailable
		>
		/** Closes the pending requests of a Session, for example when its Turn stops. */
		readonly cancel: (
			organizationId: string,
			session: Session.Id,
		) => Effect.Effect<void, BotsApi.BotStorageUnavailable>
	}
>()("@openbot-build/openbot/capabilities/Requests") {}

/** How long a request waits before it is denied, when the settings cannot be read. */
export const defaultTimeout = 24 * 60 * 60 * 1000

export const make: Effect.Effect<
	typeof Requests.Service,
	never,
	BotRecords | Grants | Rules | Settings
> = Effect.gen(function* () {
	const settings = yield* Settings
	const records = yield* BotRecords
	const grants = yield* Grants
	const rules = yield* Rules
	const requests = records.collection(
		"request",
		Stored,
		RequestsApi.RequestStatus,
	)
	/** Each organization says how long its requests wait. */
	const timeoutOf = (organizationId: string) =>
		settings.organization(organizationId).pipe(
			Effect.map((current) => current.document.requestTimeoutMs),
			Effect.orElseSucceed(() => defaultTimeout),
		)
	const put = (organizationId: string, stored: Stored) =>
		requests
			.put(
				{
					organizationId,
					id: stored.request.id,
					owner: approverKey(stored.request.approver),
					scope: stored.request.session,
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
				...request.endorsements.map((entry) => ({
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
				...request.endorsements.map((entry) => entry.bot),
			]
			let parent: string | undefined = undefined
			for (let index = receivers.length - 1; index >= 0; index--) {
				const bot = receivers[index]!
				const giver = givers[index]!
				const grant: BotsApi.Grant = yield* grants.create(
					organizationId,
					{
						bot,
						capability: request.capability,
						effect: "allow",
						scope: giver.scope,
						...(giver.scope === "session"
							? {
									session: sessionOf({
										chain: stored.chain,
										bot,
										current: request.session,
									}),
								}
							: {}),
						grantedBy: giver.by,
						...(giver.reason === undefined ? {} : { reason: giver.reason }),
						...(parent === undefined ? {} : { parent }),
					},
					// The waiting call uses a `once` decision now.
					true,
				)
				parent = grant.id
			}
		})
	const decide: typeof Requests.Service.decide = (
		organizationId,
		id,
		decision,
	) =>
		records.transaction(
			"request:" + organizationId + ":" + id,
			Effect.gen(function* () {
				const found = yield* requests.find(organizationId, id)
				if (Option.isNone(found))
					return yield* RequestsApi.RequestNotFound.make({ request: id })
				const stored = found.value
				const request = stored.request
				if (request.status !== "pending")
					return yield* RequestsApi.RequestConflict.make({
						message: "The request is already closed.",
					})
				if (
					decision.expected !== undefined &&
					decision.expected !== request.revision
				)
					return yield* RequestsApi.RequestConflict.make({
						message: "The request changed. Read it again and retry.",
					})
				if (deciderKey(decision.by) !== approverKey(request.approver))
					return yield* RequestsApi.RequestConflict.make({
						message: "The request waits for another decider.",
					})
				const now = yield* Clock.currentTimeMillis
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
				if (decision.allow) yield* giveGrants(organizationId, stored, decision)
				else if (decision.scope !== undefined && decision.scope !== "once")
					yield* grants.create(organizationId, {
						bot: request.bot,
						capability: request.capability,
						effect: "deny",
						scope: decision.scope,
						...(decision.scope === "session"
							? { session: request.session }
							: {}),
						grantedBy: decision.by,
						...(decision.reason === undefined
							? {}
							: { reason: decision.reason }),
					})
				return {
					_tag: "Final" as const,
					stored: yield* put(organizationId, {
						...stored,
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
					reason: allow
						? "Nobody answered the request in time, and the settings allow it then."
						: status === "expired"
							? "Nobody answered the request in time."
							: "The work stopped before the request was answered.",
					at: now,
				},
				revision: stored.request.revision + 1,
			},
		})
	}
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
					request: {
						id: "req_" + randomUUID().replaceAll("-", ""),
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
						session: input.session,
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
					owner: "person:" + userId,
					...(status === undefined ? {} : { status }),
				})
				.pipe(Effect.map((list) => list.map((stored) => stored.request))),
		forSession: (organizationId, session) =>
			requests.list(organizationId, { scope: session }),
		pending: requests.withStatus("pending"),
		decide,
		pass: (organizationId, id, from) =>
			records.transaction(
				"request:" + organizationId + ":" + id,
				Effect.gen(function* () {
					const found = yield* requests.find(organizationId, id)
					if (
						Option.isNone(found) ||
						found.value.request.status !== "pending" ||
						approverKey(found.value.request.approver) !== "bot:" + from
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
		expireOne: (organizationId, id) =>
			records.transaction(
				"request:" + organizationId + ":" + id,
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis
					const found = yield* requests.find(organizationId, id)
					if (
						Option.isNone(found) ||
						found.value.request.status !== "pending" ||
						found.value.request.expiresAt > now
					)
						return Option.none()
					return Option.some(
						yield* close(organizationId, found.value, "expired", now),
					)
				}),
			),
		expire: Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis
			const pending = yield* requests.withStatus("pending")
			return yield* Effect.forEach(
				pending.filter((entry) => entry.value.request.expiresAt <= now),
				(entry) =>
					close(entry.organizationId, entry.value, "expired", now).pipe(
						Effect.map((value) => ({
							organizationId: entry.organizationId,
							value,
						})),
					),
			)
		}),
		cancel: (organizationId, session) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				const list = yield* requests.list(organizationId, {
					scope: session,
					status: "pending",
				})
				yield* Effect.forEach(list, (stored) =>
					close(organizationId, stored, "cancelled", now),
				)
			}),
	})
})
export const layer = Layer.effect(Requests, make)
