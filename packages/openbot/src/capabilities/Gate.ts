import type { Session } from "@openbot-build/core"
import type { Services as AuthorizationServices } from "../authorization/Authorize.ts"
import type { AgentsApi, AppExecution } from "@openbot-build/api"
import { Context, Effect, Layer, Option } from "effect"
import { can } from "../authorization/Check.ts"
import { Signal, Signals } from "../agents/Signals.ts"
import { type Capability, describe, permission } from "./Capability.ts"
import { Grants } from "./Grants.ts"
import { Judge } from "./Judge.ts"
import { Requests } from "./Requests.ts"
import { Rules } from "./Rules.ts"
import { Work } from "./Work.ts"

/** What a tool call does after the check: run now, or wait for an answer. */
export type Answer = "allow" | "pause"

export interface Attempt {
	readonly capability: Capability
	/** Why the Agent wants it, in its own words. */
	readonly reason: string
	readonly toolCallId: string
	/** The target Agent, for actions on an Agent. */
	readonly target?: AgentsApi.Agent
	/** The deployment owner allows this without asking, for example a read-only App tool. */
	readonly implicit?: boolean
	readonly app?: AppExecution.Invocation
}

/**
 * Checks each attempt of an Agent to use a capability. Agents have no limits that they know of.
 * The steps are: the policy of the member, Grants, Rules with the judge, and then a request
 * to the decider above the Agent.
 */
export class Gate extends Context.Service<
	Gate,
	{
		/**
		 * Never fails. When anything goes wrong, the answer is "pause", so the call waits
		 * and never runs without a decision.
		 */
		readonly check: (attempt: Attempt) => Effect.Effect<Answer>
		/** True when an Agent may use the capability without asking anybody. */
		readonly holds: (input: {
			readonly organizationId: string
			readonly agent: AgentsApi.Agent
			readonly capability: Capability
			readonly session: Session.Id
		}) => Effect.Effect<boolean>
	}
>()("@openbot-build/openbot/capabilities/Gate") {}

export const make: Effect.Effect<
	typeof Gate.Service,
	never,
	Grants | Rules | Judge | Requests | Signals | AuthorizationServices
> = Effect.gen(function* () {
	const grants = yield* Grants
	const rules = yield* Rules
	const judge = yield* Judge
	const requests = yield* Requests
	const signals = yield* Signals
	const services = yield* Effect.context<AuthorizationServices>()
	/** The verdict of the Rules for an Agent, and the Agents that wrote the Rules it quotes. */
	const judged = (input: {
		readonly organizationId: string
		readonly agent: AgentsApi.Agent
		readonly capability: Capability
		readonly reason: string
	}) =>
		Effect.gen(function* () {
			const list = yield* rules.list(input.organizationId, input.agent.id)
			const verdict = yield* judge.decide({ ...input, rules: list })
			const authors = verdict.citations.flatMap((citation) =>
				list
					.filter((rule) => rule.id === citation.rule)
					.map((rule) => rule.author),
			)
			return { verdict, authors }
		})
	/**
	 * True when an Agent holds a capability by a Grant, or by a Rule from a person.
	 * A Rule from an Agent counts only when that Agent holds the capability too.
	 */
	const holds = (input: {
		readonly organizationId: string
		readonly agent: AgentsApi.Agent
		readonly capability: Capability
		readonly session: Session.Id
		readonly depth?: number
	}): Effect.Effect<boolean> =>
		Effect.gen(function* () {
			if ((input.depth ?? 0) > 8) return false
			const grant = yield* grants.match({
				organizationId: input.organizationId,
				agent: input.agent.id,
				capability: input.capability,
				session: input.session,
			})
			if (Option.isSome(grant)) return grant.value.effect === "allow"
			const { verdict, authors } = yield* judged({
				...input,
				reason: "A decider checks whether it may allow this itself.",
			})
			if (verdict.decision !== "allow") return false
			return authors.every((author) => author._tag === "Person")
		}).pipe(Effect.orElseSucceed(() => false))
	const check: typeof Gate.Service.check = (attempt) =>
		Effect.gen(function* () {
			const work = yield* Effect.serviceOption(Work)
			// Without the current Agent nothing can decide, so the call waits.
			if (Option.isNone(work)) return "pause" as const
			const current = work.value
			const organizationId = current.caller.organizationId
			const record = (decided?: {
				readonly allow: boolean
				readonly by: AgentsApi.Decider
				readonly reason?: string
			}) =>
				requests
					.create(organizationId, {
						agent: current.agent.id,
						chain: current.chain,
						deciders: current.deciders,
						capability: attempt.capability,
						reason: attempt.reason,
						session: current.session,
						turn: current.turn,
						toolCallId: attempt.toolCallId,
						...(attempt.app === undefined ? {} : { app: attempt.app }),
						...(decided === undefined ? {} : { decided }),
					})
					.pipe(
						Effect.tap((stored) =>
							signals.publish(
								Signal.RequestChanged({
									organizationId,
									request: stored.request.id,
								}),
							),
						),
						Effect.as("pause" as const),
					)
			const needed = permission({
				caller: current.caller,
				capability: attempt.capability,
				session: current.session,
				self: current.agent,
				...(attempt.target === undefined ? {} : { agent: attempt.target }),
			})
			const member = yield* can({
				caller: current.caller,
				permission: needed.permission,
				key: needed.key,
			}).pipe(
				Effect.provideContext(services),
				Effect.orElseSucceed(() => false),
			)
			if (!member)
				return yield* record({
					allow: false,
					by: { _tag: "Person", userId: current.caller.userId },
					reason:
						"The policy of the organization does not let this person " +
						describe(attempt.capability) +
						".",
				})
			if (attempt.implicit === true) return "allow" as const
			const grant = yield* grants.match({
				organizationId,
				agent: current.agent.id,
				capability: attempt.capability,
				session: current.session,
			})
			if (Option.isSome(grant)) {
				if (grant.value.effect === "deny")
					return yield* record({
						allow: false,
						by: grant.value.grantedBy,
						reason: grant.value.reason ?? "A Grant denies this.",
					})
				yield* grants.use(organizationId, grant.value)
				return "allow" as const
			}
			const { verdict, authors } = yield* judged({
				organizationId,
				agent: current.agent,
				capability: attempt.capability,
				reason: attempt.reason,
			})
			const rule = verdict.citations[0]?.rule ?? ""
			if (verdict.decision === "deny")
				return yield* record({
					allow: false,
					by: { _tag: "Rule", rule },
					reason: verdict.explanation,
				})
			if (verdict.decision === "allow") {
				const all = yield* Effect.forEach(authors, (author) =>
					author._tag === "Agent"
						? Effect.gen(function* () {
								// Only an Agent above this one in its owner chain can set its Rules.
								if (!current.deciders.includes(author.agent)) return false
								const index = current.chain.agents.indexOf(author.agent)
								return yield* holds({
									organizationId,
									agent: { ...current.agent, id: author.agent },
									capability: attempt.capability,
									session:
										(index < 0 ? undefined : current.chain.sessions[index]) ??
										current.session,
									depth: 1,
								})
							})
						: Effect.succeed(true),
				)
				if (all.every(Boolean)) return "allow" as const
			}
			return yield* record()
		}).pipe(
			Effect.catchCause((cause) =>
				Effect.logWarning(
					"A capability check failed, so the call waits",
					cause,
				).pipe(Effect.as("pause" as const)),
			),
		)
	return Gate.of({ check, holds })
})
export const layer = Layer.effect(Gate, make)
