import * as ExecutionFence from "../execution/ExecutionFence.ts"
import { createHash } from "node:crypto"
import {
	Session,
	Timeline,
	TimelineSnapshots,
	type Turn,
} from "@openbot-build/core"
import { PgClient } from "@effect/sql-pg"
import * as SessionRepository from "../sessions/RepositoryPostgres.ts"
import { ownerKey } from "../apps/Repository.ts"
import { Invocations } from "../apps/Invocations.ts"
import { AgentsApi, type AppExecution, RequestsApi } from "@openbot-build/api"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { AgentRecords } from "../agents/AgentRecords.ts"
import { Chain, hostState } from "../sessions/SessionHost.ts"
import { Stored as StoredDelegation } from "../agents/Delegations.ts"
import { Grants } from "./Grants.ts"
import { Rules, deciderKey } from "./Rules.ts"

type Request = RequestsApi.CapabilityRequest
type Approver = Request["approver"]

/** An automated answer can arrive before the target wait is saved. */
const DeferredDecision = Schema.Struct({
	by: AgentsApi.Decider,
	allow: Schema.Boolean,
	scope: Schema.optionalKey(AgentsApi.GrantScope),
	reason: Schema.optionalKey(Schema.String),
	question: Schema.optionalKey(Schema.String),
	holds: Schema.optionalKey(Schema.Boolean),
	rule: Schema.optionalKey(Schema.String),
	grantReads: Schema.optionalKey(Schema.Boolean),
})
/** A request as it is stored: the public record and the chain it came through. */
export const Stored = Schema.Struct({
	request: RequestsApi.CapabilityRequest,
	chain: Chain,
	settled: Schema.Boolean,
	deferred: Schema.optionalKey(DeferredDecision),
})
export type Stored = typeof Stored.Type

/** The decider above an Agent in a chain: the Agent before it, or the person at the top. */
export const superior = ({
	chain,
	agent,
}: {
	readonly chain: Chain
	readonly agent: string
}): Approver => {
	const index = chain.agents.indexOf(agent as AgentsApi.AgentId)
	return index > 0
		? { _tag: "Agent", agent: chain.agents[index - 1]! }
		: { _tag: "Person", userId: chain.userId }
}

/** The Session where an Agent of the chain works. The last Agent works in `current`. */
const sessionOf = (chain: Chain, agent: string, current: Session.Id) => {
	const index = chain.agents.indexOf(agent as AgentsApi.AgentId)
	return index >= 0 && index < chain.sessions.length
		? chain.sessions[index]!
		: current
}

const approverKey = (approver: Approver) =>
	approver._tag === "Person"
		? "person:" + approver.userId
		: "agent:" + approver.agent

export interface Decision {
	readonly by: AgentsApi.Decider
	readonly allow: boolean
	readonly scope?: AgentsApi.GrantScope
	readonly reason?: string
	readonly question?: string
	readonly expected?: number
	readonly expectedSessionRevision?: number
	readonly expectedSessionId?: Session.Id
	readonly grantReads?: boolean
	/** For an allow by an Agent: true when the Agent holds the capability itself. */
	readonly holds?: boolean
	/** Keep the decision as a Rule for the requesting Agent. */
	readonly rule?: string
}

/** The result of a decision: the request is final, or it went up to the next decider. */
export type Outcome =
	| { readonly _tag: "Final"; readonly stored: Stored }
	| { readonly _tag: "Escalated"; readonly stored: Stored }
	| { readonly _tag: "Deferred"; readonly stored: Stored }

/**
 * Requests of Agents for capabilities. A request waits for one decider at a time.
 * This service only keeps records. The coordinator starts reviews and lets the work go on.
 */
export class Requests extends Context.Service<
	Requests,
	{
		readonly create: (
			organizationId: string,
			input: {
				readonly agent: AgentsApi.AgentId
				readonly chain: Chain
				readonly capability: AgentsApi.Capability
				readonly reason: string
				readonly session: Session.Id
				readonly turn: Turn.Id
				readonly toolCallId: string
				readonly callOccurrence: number
				readonly app?: AppExecution.Invocation
				/** A request that is decided at once, for example by a Grant or by policy. */
				readonly decided?: {
					readonly allow: boolean
					readonly by: AgentsApi.Decider
					readonly reason?: string
				}
			},
		) => Effect.Effect<Stored, AgentsApi.AgentStorageUnavailable>
		/** Final decisions whose exact waiting call has not yet been settled. */
		readonly recoverable: Effect.Effect<
			ReadonlyArray<{
				readonly organizationId: string
				readonly value: Stored
			}>,
			AgentsApi.AgentStorageUnavailable
		>
		readonly markSettled: (
			organizationId: string,
			id: string,
		) => Effect.Effect<void, AgentsApi.AgentStorageUnavailable>
		readonly find: (
			organizationId: string,
			id: string,
		) => Effect.Effect<Option.Option<Stored>, AgentsApi.AgentStorageUnavailable>
		/** The requests that wait for a person, or that the person decided. */
		readonly forPerson: (
			organizationId: string,
			userId: string,
			status?: Request["status"],
		) => Effect.Effect<
			ReadonlyArray<Request>,
			AgentsApi.AgentStorageUnavailable
		>
		/** The requests of one Session. */
		readonly forSession: (
			organizationId: string,
			session: Session.Id,
		) => Effect.Effect<ReadonlyArray<Stored>, AgentsApi.AgentStorageUnavailable>
		readonly pending: Effect.Effect<
			ReadonlyArray<{
				readonly organizationId: string
				readonly value: Stored
			}>,
			AgentsApi.AgentStorageUnavailable
		>
		readonly decide: (
			organizationId: string,
			id: string,
			decision: Decision,
		) => Effect.Effect<
			Outcome,
			| RequestsApi.RequestNotFound
			| RequestsApi.RequestConflict
			| AgentsApi.AgentStorageUnavailable
		>
		/** Apply an already saved automated answer when its wait is durable. */
		readonly applyDeferred: (
			organizationId: string,
			id: string,
		) => Effect.Effect<
			boolean,
			| RequestsApi.RequestNotFound
			| RequestsApi.RequestConflict
			| AgentsApi.AgentStorageUnavailable
		>
		/** Closes pending requests whose time is over. Returns the closed requests. */
		/**
		 * Sends a pending request to the next decider without support, for example when a
		 * review ended without a decision.
		 */
		readonly pass: (
			organizationId: string,
			id: string,
			from: AgentsApi.AgentId,
		) => Effect.Effect<Option.Option<Stored>, AgentsApi.AgentStorageUnavailable>
		readonly expire: Effect.Effect<
			ReadonlyArray<{
				readonly organizationId: string
				readonly value: Stored
			}>,
			AgentsApi.AgentStorageUnavailable
		>
		/** Closes the pending requests of a Session, for example when its Turn stops. */
		readonly cancel: (
			organizationId: string,
			session: Session.Id,
		) => Effect.Effect<void, AgentsApi.AgentStorageUnavailable>
	}
>()("@openbot-build/openbot/capabilities/Requests") {}

/** How long a request waits before it is denied. */
export const defaultTimeout = 24 * 60 * 60 * 1000

export const make = (
	options: { readonly timeout?: number } = {},
): Effect.Effect<
	typeof Requests.Service,
	never,
	AgentRecords | Grants | Rules | PgClient.PgClient
> =>
	Effect.gen(function* () {
		const records = yield* AgentRecords
		const sql = yield* PgClient.PgClient
		const sessions = yield* SessionRepository.make
		const grants = yield* Grants
		const rules = yield* Rules
		const requests = records.collection(
			"request",
			Stored,
			Schema.Literals([...RequestsApi.RequestStatus.literals, "resolved"]),
		)
		const timeout = options.timeout ?? defaultTimeout
		const put = (organizationId: string, stored: Stored) =>
			requests
				.put(
					{
						organizationId,
						id: stored.request.id,
						owner: approverKey(stored.request.approver),
						scope: stored.request.session,
						status: stored.settled ? "resolved" : stored.request.status,
					},
					stored,
				)
				.pipe(Effect.as(stored))
		/** Gives the Grants down the chain, from the top decider to the requesting Agent. */
		const giveGrants = (
			organizationId: string,
			stored: Stored,
			final: Decision,
		) =>
			Effect.gen(function* () {
				const request = stored.request
				// Givers from the bottom: each endorsing Agent, then the final decider.
				const givers: ReadonlyArray<{
					readonly by: AgentsApi.Decider
					readonly scope: AgentsApi.GrantScope
					readonly reason?: string
				}> = [
					...request.endorsements.map((entry) => ({
						by: { _tag: "Agent" as const, agent: entry.agent },
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
					request.agent,
					...request.endorsements.map((entry) => entry.agent),
				]
				let parent: string | undefined = undefined
				for (let index = receivers.length - 1; index >= 0; index--) {
					const agent = receivers[index]!
					const giver = givers[index]!
					const grant: AgentsApi.Grant = yield* grants.create(
						organizationId,
						{
							agent,
							capability: request.capability,
							effect: "allow",
							scope: giver.scope,
							...(giver.scope === "session"
								? {
										session: sessionOf(stored.chain, agent, request.session),
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
		/** Check the waiting chain while its Session rows cannot be changed or stopped. */
		const checkSession = (
			organizationId: string,
			stored: Stored,
			expected: number | undefined,
			displayed: Session.Id = stored.request.session,
			allowEarly = false,
		) =>
			Effect.gen(function* () {
				const stale = () =>
					RequestsApi.RequestConflict.make({
						message:
							"The Session or waiting call changed. Read it again and retry.",
					})
				const namespace = ownerKey({
					organizationId,
					userId: stored.chain.userId,
				})
				const chain = [...stored.chain.sessions, stored.request.session]
				if (
					!chain.includes(displayed) ||
					new Set(chain).size !== chain.length ||
					stored.chain.organizationId !== organizationId
				)
					return yield* stale()
				const locked = new Map<Session.Id, Session.Ref>()
				// A stable lock order also covers decisions shown in a parent Session.
				for (const id of [...chain].sort()) {
					const rows = yield* sql<{
						body: string
					}>`SELECT body FROM openbot_session_references WHERE namespace = ${namespace} AND id = ${id} FOR UPDATE`
					if (rows[0] === undefined) return yield* stale()
					const ref = yield* Schema.decodeEffect(
						Schema.fromJsonString(Session.Ref),
					)(rows[0].body)
					const identity = hostState(ref)
					if (
						identity?.chain.organizationId !== organizationId ||
						identity.chain.userId !== stored.chain.userId ||
						(Session.status(ref)._tag !== "Waiting" &&
							!(
								allowEarly &&
								id === stored.request.session &&
								Session.status(ref)._tag === "Running"
							))
					)
						return yield* stale()
					locked.set(id, ref)
				}
				if (
					expected !== undefined &&
					locked.get(displayed)?.revision !== expected
				)
					return yield* stale()
				const waits = (session: Session.Ref) =>
					Effect.gen(function* () {
						const state = yield* TimelineSnapshots.readRaw(
							sessions.store(namespace),
							session.head,
						)
						const value = yield* Schema.decodeUnknownEffect(Timeline.Value({}))(
							state.raw,
						)
						return Session.waits({
							session,
							state: { version: state.snapshot, value },
						})
					})
				const target = locked.get(stored.request.session)!
				if (Session.currentTurn(target)?.id !== stored.request.turn)
					return yield* stale()
				// This keeps only the answer. No Grant or App operation changes until
				// the normal Waiting signal validates the exact call and delegation links.
				if (allowEarly && Session.status(target)._tag === "Running")
					return false
				if (
					Session.currentTurn(target)?.id !== stored.request.turn ||
					!(yield* waits(target)).some(
						(wait) =>
							wait.toolCallId === stored.request.toolCallId &&
							wait.occurrence === stored.request.callOccurrence,
					)
				)
					return yield* stale()
				const delegations = records.collection(
					"delegation",
					StoredDelegation,
					AgentsApi.DelegationStatus,
				)
				for (let index = chain.length - 1; index > 0; index--) {
					const child = locked.get(chain[index]!)!,
						parent = locked.get(chain[index - 1]!)!
					const current = Session.currentTurn(child),
						parentTurn = Session.currentTurn(parent)
					const links = yield* delegations.list(organizationId, {
						owner: stored.chain.userId,
						scope: parent.id,
						status: "running",
					})
					const link = links.find(
						({ delegation }) =>
							delegation.child?.session === child.id &&
							delegation.child.turn === current?.id &&
							delegation.parent.turn === parentTurn?.id,
					)
					if (
						link === undefined ||
						!(yield* waits(parent)).some(
							(wait) =>
								wait.toolCallId === link.delegation.parent.toolCallId &&
								wait.occurrence === link.delegation.parent.callOccurrence,
						)
					)
						return yield* stale()
				}
				return true
			}).pipe(
				Effect.mapError((error) =>
					error instanceof RequestsApi.RequestConflict
						? error
						: AgentsApi.AgentStorageUnavailable.make({}),
				),
			)

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
					if (stored.deferred !== undefined)
						return yield* RequestsApi.RequestConflict.make({
							message:
								"This request already has an answer waiting for its call.",
						})
					const ready = yield* checkSession(
						organizationId,
						stored,
						decision.expectedSessionRevision,
						decision.expectedSessionId,
						decision.by._tag === "Agent",
					)
					if (!ready)
						return {
							_tag: "Deferred" as const,
							stored: yield* put(organizationId, {
								...stored,
								deferred: yield* Schema.decodeEffect(DeferredDecision)(
									decision,
								).pipe(
									Effect.mapError(() =>
										AgentsApi.AgentStorageUnavailable.make({}),
									),
								),
								request: { ...request, revision: request.revision + 1 },
							}),
						}
					const now = yield* Clock.currentTimeMillis
					if (decision.rule !== undefined)
						yield* rules.create(organizationId, {
							agent: request.agent,
							author: decision.by,
							text: decision.rule,
							status: decision.by._tag === "Person" ? "active" : "proposed",
						})
					// An Agent that agrees but does not hold the capability passes the request up.
					if (
						decision.allow &&
						decision.by._tag === "Agent" &&
						decision.holds !== true
					) {
						const agent = decision.by.agent
						return {
							_tag: "Escalated" as const,
							stored: yield* put(organizationId, {
								...stored,
								request: {
									...request,
									endorsements: [
										...request.endorsements,
										{
											agent,
											scope: decision.scope ?? "once",
											...(decision.reason === undefined
												? {}
												: { reason: decision.reason }),
										},
									],
									approver: superior({ chain: stored.chain, agent }),
									revision: request.revision + 1,
								},
							}),
						}
					}
					// The App operation and the Request share this transaction. A changed
					// connection is rejected before a decision or lasting grant is saved.
					if (request.app !== undefined) {
						const invocations = yield* Effect.serviceOption(Invocations)
						if (Option.isNone(invocations))
							return yield* AgentsApi.AgentStorageUnavailable.make({})
						yield* invocations.value
							.approve(
								{
									owner: ownerKey({
										organizationId,
										userId: stored.chain.userId,
									}),
									session: request.session,
									turn: request.turn,
									callOccurrence: request.callOccurrence,
								},
								request.toolCallId,
								decision.allow,
								decision.grantReads ?? false,
							)
							.pipe(
								Effect.mapError((error) =>
									error._tag === "SessionConflict"
										? RequestsApi.RequestConflict.make({
												message: error.message,
											})
										: AgentsApi.AgentStorageUnavailable.make({}),
								),
							)
					}
					if (decision.allow)
						yield* giveGrants(organizationId, stored, decision)
					else if (decision.scope !== undefined && decision.scope !== "once")
						yield* grants.create(organizationId, {
							agent: request.agent,
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
									...(decision.grantReads === undefined
										? {}
										: { grantReads: decision.grantReads }),
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
		) =>
			records.transaction(
				"request:" + organizationId + ":" + stored.request.id,
				Effect.gen(function* () {
					const found = yield* requests.find(organizationId, stored.request.id)
					if (Option.isNone(found) || found.value.request.status !== "pending")
						return Option.none<Stored>()
					const current = found.value
					if (status === "expired" && current.request.expiresAt > now)
						return Option.none<Stored>()
					return Option.some(
						yield* put(organizationId, {
							...current,
							request: {
								...current.request,
								status,
								decision: {
									by: { _tag: "Person", userId: current.chain.userId },
									reason:
										status === "expired"
											? "Nobody answered the request in time."
											: "The work stopped before the request was answered.",
									at: now,
								},
								revision: current.request.revision + 1,
							},
						}),
					)
				}),
			)

		return Requests.of({
			create: (organizationId, input) =>
				records.transaction(
					"request-call:" + organizationId + ":" + input.session,
					Effect.gen(function* () {
						const id =
							"req_" +
							createHash("sha256")
								.update(
									JSON.stringify([
										input.session,
										input.turn,
										input.toolCallId,
										input.callOccurrence,
									]),
								)
								.digest("hex")
						const existing = yield* requests.find(organizationId, id)
						if (Option.isSome(existing)) return existing.value
						const now = yield* Clock.currentTimeMillis
						const status: Request["status"] =
							input.decided === undefined
								? "pending"
								: input.decided.allow
									? "allowed"
									: "denied"
						return yield* put(organizationId, {
							chain: input.chain,
							settled: false,
							request: {
								id,
								agent: input.agent,
								capability: input.capability,
								reason: input.reason,
								approver: superior({ chain: input.chain, agent: input.agent }),
								chain: input.chain.agents,
								session: input.session,
								turn: input.turn,
								toolCallId: input.toolCallId,
								callOccurrence: input.callOccurrence,
								...(input.app === undefined ? {} : { app: input.app }),
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
							},
						})
					}),
				),
			recoverable: Effect.forEach(
				["allowed", "denied", "expired", "cancelled"] as const,
				(status) => requests.withStatus(status),
			).pipe(Effect.map((groups) => groups.flat())),
			markSettled: (organizationId, id) =>
				records.transaction(
					"request:" + organizationId + ":" + id,
					Effect.gen(function* () {
						const found = yield* requests.find(organizationId, id)
						if (
							Option.isSome(found) &&
							found.value.request.status !== "pending"
						)
							yield* put(organizationId, { ...found.value, settled: true })
					}),
				),
			find: (organizationId, id) => requests.find(organizationId, id),
			forPerson: (organizationId, userId, status) =>
				requests
					.list(organizationId, { owner: "person:" + userId })
					.pipe(
						Effect.map((list) =>
							list
								.map((stored) => stored.request)
								.filter(
									(request) =>
										status === undefined || request.status === status,
								),
						),
					),
			forSession: (organizationId, session) =>
				requests.list(organizationId, { scope: session }),
			pending: requests.withStatus("pending"),
			decide,
			applyDeferred: (organizationId, id) =>
				records.transaction(
					"request:" + organizationId + ":" + id,
					Effect.gen(function* () {
						const found = yield* requests.find(organizationId, id)
						if (
							Option.isNone(found) ||
							found.value.request.status !== "pending" ||
							found.value.deferred === undefined
						)
							return false
						const { deferred, ...stored } = found.value
						yield* put(organizationId, stored)
						const outcome = yield* decide(organizationId, id, {
							...deferred,
							expected: stored.request.revision,
						})
						return outcome._tag !== "Deferred"
					}),
				),
			pass: (organizationId, id, from) =>
				records.transaction(
					"request:" + organizationId + ":" + id,
					Effect.gen(function* () {
						const found = yield* requests.find(organizationId, id)
						if (
							Option.isNone(found) ||
							found.value.request.status !== "pending" ||
							found.value.deferred !== undefined ||
							approverKey(found.value.request.approver) !== "agent:" + from
						)
							return Option.none()
						const stored = found.value
						return Option.some(
							yield* put(organizationId, {
								...stored,
								request: {
									...stored.request,
									approver: superior({ chain: stored.chain, agent: from }),
									revision: stored.request.revision + 1,
								},
							}),
						)
					}),
				),
			expire: Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				const pending = yield* requests.withStatus("pending")
				const closed = yield* Effect.forEach(
					pending.filter((entry) => entry.value.request.expiresAt <= now),
					(entry) =>
						ExecutionFence.admit(
							entry.value.chain.userId,
							close(entry.organizationId, entry.value, "expired", now),
						).pipe(
							Effect.map((value) =>
								Option.map(value, (value) => ({
									organizationId: entry.organizationId,
									value,
								})),
							),
							// One frozen account must not stop expiry for other accounts.
							Effect.orElseSucceed(() => Option.none()),
						),
				)
				return closed.flatMap((entry) =>
					Option.isSome(entry) ? [entry.value] : [],
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
export const layer = (options: { readonly timeout?: number } = {}) =>
	Layer.effect(Requests, make(options))
