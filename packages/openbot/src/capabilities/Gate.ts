import type { Chat } from "@openbot-build/core"
import type {
	BotsApi,
	AppExecution,
	CodeRunsApi,
	ComputersApi,
} from "@openbot-build/api"
import {
	Array as Arr,
	Cause,
	Context,
	Data,
	Effect,
	HashMap,
	Layer,
	Option,
	Ref,
	pipe,
} from "effect"
import * as Check from "../authorization/Check.ts"
import { Bots } from "../bots/Bots.ts"
import { Signal, Signals } from "../bots/Signals.ts"
import { type Capability, describe, memberTarget } from "./Capability.ts"
import { Grants } from "./Grants.ts"
import { Judge } from "./Judge.ts"
import { type Ask, Requests, chatOf } from "./Requests.ts"
import { Rules } from "./Rules.ts"
import { Work } from "./Work.ts"

/**
 * What a tool call does after the check. `Allow` runs it now. `Deny` does not run it,
 * and the Bot gets the reason. `Pending` waits for a decider: the Bot goes on at once,
 * and the answer comes back to its Chat later.
 */
export type Answer = Data.TaggedEnum<{
	Allow: {}
	Deny: { readonly request?: string; readonly reason: string }
	Pending: { readonly request: string }
}>
export const Answer = Data.taggedEnum<Answer>()

export interface Attempt {
	readonly capability: Capability
	/** Why the Bot wants it, in its own words. */
	readonly reason: string
	readonly toolCallId: string
	/** The target Bot, for actions on a Bot. */
	readonly target?: BotsApi.Bot
	/** The owner of the target Computer or Computer provider, for actions on Computers. */
	readonly computerOwner?: ComputersApi.ComputerOwner
	/** The deployment owner allows this without asking, for example a read-only App tool. */
	readonly implicit?: boolean
	readonly app?: AppExecution.Invocation
	/** The Code Mode program that makes the call. Deciders see it with the request. */
	readonly code?: CodeRunsApi.RequestCode
	/** How the request waits, when the attempt needs one. */
	readonly ask?: Ask
}

/**
 * Checks each attempt of a Bot to use a capability. Bots have no limits that they know of.
 * The steps are: the policy of the member, Grants, Rules with the judge, and then a request
 * to the decider above the Bot. The Grants of a Bot are an ability policy, see `Policy.ts`.
 */
export class Gate extends Context.Service<
	Gate,
	{
		/**
		 * Never fails. When anything goes wrong, the answer is `Deny`, so the call never
		 * runs without a decision.
		 */
		readonly check: (attempt: Attempt) => Effect.Effect<Answer>
		/** True when a Bot may use the capability without asking anybody. */
		readonly holds: (input: {
			readonly organizationId: string
			readonly bot: BotsApi.Bot
			readonly capability: Capability
			readonly chat: Chat.Id
		}) => Effect.Effect<boolean>
	}
>()("@openbot-build/openbot/capabilities/Gate") {}

/**
 * Keeps the answer for a tool call with the Turn, so an approval of the call finds it.
 * A tool whose own check fails before the Gate keeps a `Deny` here, so the call never runs.
 * The Work belongs to the current Turn of a Bot. Outside of one there is no Turn to keep
 * the answer, so it is not kept.
 */
export const remember = (toolCallId: string, answer: Answer) =>
	Effect.serviceOption(Work).pipe(
		Effect.flatMap((work) =>
			Option.isNone(work)
				? Effect.void
				: Ref.update(work.value.checks, HashMap.set(toolCallId, answer)),
		),
	)

export const make: Effect.Effect<
	typeof Gate.Service,
	never,
	Bots | Grants | Rules | Judge | Requests | Signals | Check.Services
> = Effect.gen(function* () {
	const bots = yield* Bots
	const grants = yield* Grants
	const rules = yield* Rules
	const judge = yield* Judge
	const requests = yield* Requests
	const signals = yield* Signals
	const checks = yield* Check.make
	/** The verdict of the Rules for a Bot, and the Bots that wrote the Rules it quotes. */
	const judged = (input: {
		readonly organizationId: string
		readonly bot: BotsApi.Bot
		readonly capability: Capability
		readonly reason: string
	}) =>
		Effect.gen(function* () {
			const list = yield* rules.list(input.organizationId, input.bot.id)
			const verdict = yield* judge.decide({ ...input, rules: list })
			const authors = Arr.flatMap(verdict.citations, (citation) =>
				pipe(
					list,
					Arr.filter((rule) => rule.id === citation.rule),
					Arr.map((rule) => rule.author),
				),
			)
			return { verdict, authors }
		})
	/**
	 * True when a Bot holds a capability by a Grant, or by Rules that only people wrote.
	 * A Rule from a Bot does not count here.
	 */
	const holds = (input: {
		readonly organizationId: string
		readonly bot: BotsApi.Bot
		readonly capability: Capability
		readonly chat: Chat.Id
	}): Effect.Effect<boolean> =>
		Effect.gen(function* () {
			const grant = yield* grants.match({
				organizationId: input.organizationId,
				bot: input.bot.id,
				capability: input.capability,
				chat: input.chat,
			})
			if (Option.isSome(grant)) return grant.value.effect === "allow"
			const { verdict, authors } = yield* judged({
				...input,
				reason: "A decider checks whether it may allow this itself.",
			})
			if (verdict.decision !== "allow") return false
			return Arr.every(authors, (author) => author._tag === "Person")
		}).pipe(
			// Without an answer, the decider must ask, as when it does not hold the capability.
			Effect.catchCause((cause) =>
				Cause.hasInterruptsOnly(cause)
					? Effect.interrupt
					: Effect.logWarning(
							"OpenBot could not check whether a decider holds a capability",
							cause,
						).pipe(Effect.as(false)),
			),
			// The arguments of the capability stay out of the logs, because they hold user data.
			Effect.annotateLogs({
				bot: input.bot.id,
				action: input.capability.action,
				target: input.capability.target,
			}),
		)
	const check: typeof Gate.Service.check = (attempt) =>
		Effect.gen(function* () {
			// The Work belongs to the current Turn of a Bot, so each call reads it from the
			// context. Tool handlers cannot name it in their type. Without the current Bot
			// nothing can decide, so the call does not run.
			const work = yield* Effect.serviceOption(Work)
			if (Option.isNone(work))
				return Answer.Deny({ reason: "No Bot runs this work." })
			const current = work.value
			const organizationId = current.caller.organizationId
			const record = (decided?: {
				readonly allow: boolean
				readonly by: BotsApi.Decider
				readonly reason?: string
			}) =>
				requests
					.create(organizationId, {
						bot: current.bot.id,
						chain: current.chain,
						deciders: current.deciders,
						capability: attempt.capability,
						reason: attempt.reason,
						chat: current.chat,
						turn: current.turn,
						toolCallId: attempt.toolCallId,
						...(attempt.app === undefined ? {} : { app: attempt.app }),
						...(attempt.code === undefined ? {} : { code: attempt.code }),
						...(attempt.ask === undefined ? {} : { ask: attempt.ask }),
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
						// The Coordinator starts the review on this signal, so an
						// interruption must not come between the write and the signal.
						Effect.uninterruptible,
						Effect.map((stored): Answer =>
							stored.request.status === "denied"
								? Answer.Deny({
										request: stored.request.id,
										reason:
											stored.request.decision?.reason ??
											"The request was denied.",
									})
								: Answer.Pending({ request: stored.request.id }),
						),
					)
			const needed = memberTarget({
				caller: current.caller,
				capability: attempt.capability,
				chat: current.chat,
				self: current.bot,
				...(attempt.target === undefined ? {} : { bot: attempt.target }),
				...(attempt.computerOwner === undefined
					? {}
					: { computerOwner: attempt.computerOwner }),
			})
			// A policy that cannot be read is not a "no" of the policy. The check below
			// then fails, and the answer is `Deny` without a request.
			const member = yield* checks.allows(current.caller, needed)
			if (!member)
				return yield* record({
					allow: false,
					by: { _tag: "Person", userId: current.caller.userId },
					reason:
						"The policy of the organization does not let this person " +
						describe(attempt.capability) +
						".",
				})
			if (attempt.implicit === true) return Answer.Allow()
			// Some attempts must go to the person, so Grants and Rules do not answer them.
			if (attempt.ask?.person === true) return yield* record()
			const grant = yield* grants.match({
				organizationId,
				bot: current.bot.id,
				capability: attempt.capability,
				chat: current.chat,
			})
			if (Option.isSome(grant)) {
				if (grant.value.effect === "deny")
					return yield* record({
						allow: false,
						by: grant.value.grantedBy,
						reason: grant.value.reason ?? "A Grant denies this.",
					})
				// Another call may take a `once` Grant first. This call then goes on as if
				// no Grant matched.
				if (yield* grants.use(organizationId, grant.value))
					return Answer.Allow()
			}
			const { verdict, authors } = yield* judged({
				organizationId,
				bot: current.bot,
				capability: attempt.capability,
				reason: attempt.reason,
			})
			if (verdict.decision === "deny")
				return yield* Option.match(Arr.head(verdict.citations), {
					// `Judge.check` gives no_match for a verdict without a citation.
					onNone: () =>
						Effect.die("The judge gave a deny verdict without a citation."),
					onSome: ({ rule }) =>
						record({
							allow: false,
							by: { _tag: "Rule", rule },
							reason: verdict.explanation,
						}),
				})
			if (verdict.decision === "allow") {
				const all = yield* Effect.forEach(authors, (author) =>
					author._tag === "Bot"
						? Effect.gen(function* () {
								// Only a Bot above this one in its owner chain can set its Rules.
								if (!current.deciders.includes(author.bot)) return false
								const found = yield* bots.find(organizationId, author.bot)
								if (Option.isNone(found)) return false
								return yield* holds({
									organizationId,
									bot: found.value,
									capability: attempt.capability,
									chat: chatOf({
										chain: current.chain,
										bot: author.bot,
										current: current.chat,
									}),
								})
							})
						: Effect.succeed(true),
				)
				if (Arr.every(all, Boolean)) return Answer.Allow()
			}
			return yield* record()
		}).pipe(
			Effect.catchCause((cause) =>
				Cause.hasInterruptsOnly(cause)
					? Effect.interrupt
					: Effect.logWarning(
							"A capability check failed, so the call does not run",
							cause,
						).pipe(
							Effect.as(
								Answer.Deny({
									reason: "OpenBot could not check this now. Try again later.",
								}),
							),
						),
			),
			// The answer stays with the Turn, so an approval of the call finds it.
			Effect.tap((answer) => remember(attempt.toolCallId, answer)),
			// The arguments of the capability stay out of the logs, because they hold user data.
			Effect.annotateLogs({
				toolCallId: attempt.toolCallId,
				action: attempt.capability.action,
				target: attempt.capability.target,
			}),
		)
	return Gate.of({ check, holds })
})
export const layer = Layer.effect(Gate, make)
