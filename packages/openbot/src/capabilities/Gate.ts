import type { Chat } from "@openbot-build/core"
import type { Services as AuthorizationServices } from "../authorization/Authorize.ts"
import type {
	BotsApi,
	AppExecution,
	CodeRunsApi,
	ComputersApi,
} from "@openbot-build/api"
import { Context, Data, Effect, HashMap, Layer, Option, Ref } from "effect"
import { can } from "../authorization/Check.ts"
import { Signal, Signals } from "../bots/Signals.ts"
import { type Capability, describe, permission } from "./Capability.ts"
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
 * to the decider above the Bot.
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
	Grants | Rules | Judge | Requests | Signals | AuthorizationServices
> = Effect.gen(function* () {
	const grants = yield* Grants
	const rules = yield* Rules
	const judge = yield* Judge
	const requests = yield* Requests
	const signals = yield* Signals
	const services = yield* Effect.context<AuthorizationServices>()
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
			const authors = verdict.citations.flatMap((citation) =>
				list
					.filter((rule) => rule.id === citation.rule)
					.map((rule) => rule.author),
			)
			return { verdict, authors }
		})
	/**
	 * True when a Bot holds a capability by a Grant, or by a Rule from a person.
	 * A Rule from a Bot counts only when that Bot holds the capability too.
	 */
	const holds = (input: {
		readonly organizationId: string
		readonly bot: BotsApi.Bot
		readonly capability: Capability
		readonly chat: Chat.Id
		readonly depth?: number
	}): Effect.Effect<boolean> =>
		Effect.gen(function* () {
			if ((input.depth ?? 0) > 8) return false
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
			return authors.every((author) => author._tag === "Person")
		}).pipe(Effect.orElseSucceed(() => false))
	const check: typeof Gate.Service.check = (attempt) =>
		Effect.gen(function* () {
			const work = yield* Effect.serviceOption(Work)
			// Without the current Bot nothing can decide, so the call does not run.
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
			const needed = permission({
				caller: current.caller,
				capability: attempt.capability,
				chat: current.chat,
				self: current.bot,
				...(attempt.target === undefined ? {} : { bot: attempt.target }),
				...(attempt.computerOwner === undefined
					? {}
					: { computerOwner: attempt.computerOwner }),
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
				yield* grants.use(organizationId, grant.value)
				return Answer.Allow()
			}
			const { verdict, authors } = yield* judged({
				organizationId,
				bot: current.bot,
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
					author._tag === "Bot"
						? Effect.gen(function* () {
								// Only a Bot above this one in its owner chain can set its Rules.
								if (!current.deciders.includes(author.bot)) return false
								return yield* holds({
									organizationId,
									bot: { ...current.bot, id: author.bot },
									capability: attempt.capability,
									chat: chatOf({
										chain: current.chain,
										bot: author.bot,
										current: current.chat,
									}),
									depth: 1,
								})
							})
						: Effect.succeed(true),
				)
				if (all.every(Boolean)) return Answer.Allow()
			}
			return yield* record()
		}).pipe(
			Effect.catchCause((cause) =>
				Effect.logWarning(
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
		)
	return Gate.of({ check, holds })
})
export const layer = Layer.effect(Gate, make)
