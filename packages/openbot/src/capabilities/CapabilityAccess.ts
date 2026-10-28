import {
	type ExecutionIdentity,
	type Authorization,
	executionCallers,
	Bots as BotsApi,
	type Execution,
} from "@openbot-build/domain"
import type { Chain } from "../chats/ChatHost.ts"
import { type Turn, type Chat } from "@openbot-build/core"
import type * as PolicyOrigin from "./PolicyOrigin.ts"
import * as GrantUse from "./GrantUse.ts"
import type { Fence } from "../execution/Store.ts"
import * as Report from "../errors/Report.ts"
import {
	Array as Arr,
	Cause,
	Context,
	Data,
	Effect,
	Layer,
	Option,
	Schema,
	pipe,
} from "effect"
import * as Check from "../authorization/Check.ts"
import { Bots } from "../bots/Bots.ts"
import { type Capability, describe, memberTarget } from "./Capability.ts"
import type { Attempt } from "./Gate.ts"
import { Grants } from "./Grants.ts"
import { Judge } from "./Judge.ts"
import { chatOf } from "./Requests.ts"
import { Rules } from "./Rules.ts"
import type { Work } from "./Work.ts"

/** The policy result does not create a request or own any execution. */
export type Decision = Data.TaggedEnum<{
	Allow: {}
	Ask: {}
	Deny: { readonly by: BotsApi.Decider; readonly reason: string }
}>
export const Decision = Data.taggedEnum<Decision>()
export interface HoldingInput {
	readonly organizationId: string
	readonly bot: BotsApi.Bot
	readonly capability: Capability
	readonly chat: Chat.Id
}
/** A rule answer can be used only while the Bot and its Rules still match. */
export interface Holding {
	readonly botRevision: number
	readonly rules: Option.Option<ReadonlyArray<BotsApi.Rule>>
}
const sameRules = Schema.toEquivalence(Schema.Array(BotsApi.Rule))
type UseGrant = (
	current: typeof Work.Service,
	attempt: Attempt,
) => Effect.Effect<
	Option.Option<BotsApi.Grant>,
	| BotsApi.BotStorageUnavailable
	| Execution.StorageError
	| Execution.Forbidden
	| Execution.NotFound
	| Execution.Conflict
	| Execution.KeyConflict
>
export interface Service {
	readonly member: (
		current: {
			readonly identity: ExecutionIdentity
			readonly namespace: string
			readonly bot: BotsApi.Bot
			readonly chain: Chain
			readonly deciders: ReadonlyArray<BotsApi.BotId>
			readonly chat: Chat.Id
			readonly turn: Turn.Id
		},
		attempt: Attempt,
	) => Effect.Effect<
		| { readonly _tag: "Allow" }
		| {
				readonly _tag: "Deny"
				readonly by: BotsApi.Decider
				readonly reason: string
		  },
		Authorization.PolicyUnavailable
	>
	readonly check: (
		current: {
			readonly identity: ExecutionIdentity
			readonly namespace: string
			readonly bot: BotsApi.Bot
			readonly chain: Chain
			readonly deciders: ReadonlyArray<BotsApi.BotId>
			readonly chat: Chat.Id
			readonly turn: Turn.Id
		},
		attempt: Attempt,
	) => Effect.Effect<
		Decision,
		| BotsApi.BotStorageUnavailable
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.KeyConflict
		| Execution.NotFound
		| Authorization.PolicyUnavailable
		| Execution.StorageError
	>
	readonly holds: (input: HoldingInput) => Effect.Effect<boolean, never>
	readonly holding: (
		input: HoldingInput,
	) => Effect.Effect<Option.Option<Holding>>
	readonly stillHolds: (
		input: HoldingInput,
		proof: Option.Option<Holding>,
	) => Effect.Effect<boolean, BotsApi.BotStorageUnavailable>
}

export class CapabilityAccess extends Context.Service<
	CapabilityAccess,
	Service
>()("@openbot-build/openbot/capabilities/CapabilityAccess") {}

const makeWith = (useGrant: UseGrant) =>
	Effect.gen(function* () {
		const report = yield* Report.make
		const bots = yield* Bots
		const grants = yield* Grants
		const rules = yield* Rules
		const judge = yield* Judge
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
				return { verdict, authors, rules: list }
			})
		/**
		 * True when a Bot holds a capability by a Grant, or by Rules that only people wrote.
		 * A Rule from a Bot does not count here.
		 */
		const holding = (
			input: HoldingInput,
		): Effect.Effect<Option.Option<Holding>> =>
			Effect.gen(function* () {
				const grant = yield* grants.match({ ...input, bot: input.bot.id })
				if (Option.isSome(grant))
					return grant.value.effect === "allow"
						? Option.some({
								botRevision: input.bot.revision,
								rules: Option.none<ReadonlyArray<BotsApi.Rule>>(),
							})
						: Option.none<Holding>()
				const found = yield* judged({
					...input,
					reason: "A decider checks whether it may allow this itself.",
				})
				if (
					found.verdict.decision !== "allow" ||
					!Arr.every(found.authors, (author) => author._tag === "Person")
				)
					return Option.none<Holding>()
				return Option.some({
					botRevision: input.bot.revision,
					rules: Option.some(found.rules),
				})
			}).pipe(
				Effect.catchCause((cause) =>
					Cause.hasInterruptsOnly(cause)
						? Effect.interrupt
						: report(
								"OpenBot could not check whether a decider holds a capability",
								cause,
							).pipe(Effect.as(Option.none<Holding>())),
				),
				Effect.annotateLogs({
					bot: input.bot.id,
					action: input.capability.action,
				}),
			)
		/** Reads current records only. It is safe inside the decision transaction. */
		const stillHolds = (input: HoldingInput, proof: Option.Option<Holding>) =>
			Effect.gen(function* () {
				if (
					Option.isNone(proof) ||
					proof.value.botRevision !== input.bot.revision
				)
					return false
				const grant = yield* grants.match({ ...input, bot: input.bot.id })
				if (Option.isSome(grant)) return grant.value.effect === "allow"
				if (Option.isNone(proof.value.rules)) return false
				return sameRules(
					proof.value.rules.value,
					yield* rules.list(input.organizationId, input.bot.id),
				)
			})
		const holds = (input: HoldingInput) =>
			holding(input).pipe(Effect.map(Option.isSome))

		/** Recheck current member and token rights without using a Grant or asking the Judge. */
		const member = Effect.fn("CapabilityAccess.member")(function* (
			current: typeof Work.Service,
			attempt: Attempt,
		) {
			const needed = memberTarget({
				owner: current.identity.owner,
				...(current.identity.channel === undefined
					? {}
					: { channel: current.identity.channel }),
				capability: attempt.capability,
				chat: current.chat,
				self: current.bot,
				...(attempt.target === undefined ? {} : { bot: attempt.target }),
				...(attempt.computerOwner === undefined
					? {}
					: { computerOwner: attempt.computerOwner }),
			})
			for (const caller of executionCallers(current.identity)) {
				if (yield* checks.allows(caller, needed)) continue
				return Decision.Deny({
					by: { _tag: "Person", userId: caller.userId },
					reason:
						"The policy of the organization does not let this person " +
						describe(attempt.capability) +
						".",
				})
			}
			return Decision.Allow()
		})

		const check = Effect.fn("CapabilityAccess.check")(function* (
			current: typeof Work.Service,
			attempt: Attempt,
		) {
			const organizationId = current.identity.actor.organizationId
			const record = (decided?: {
				readonly allow: boolean
				readonly by: BotsApi.Decider
				readonly reason?: string
			}) =>
				Effect.succeed(
					decided === undefined
						? Decision.Ask()
						: decided.allow
							? Decision.Allow()
							: Decision.Deny({
									by: decided.by,
									reason: decided.reason ?? "The request was denied.",
								}),
				)

			const allowed = yield* member(current, attempt)
			if (allowed._tag === "Deny") return allowed
			if (attempt.implicit === true) return Decision.Allow()
			// Some attempts must go to the person, so Grants and Rules do not answer them.
			if (attempt.ask?.person === true) return yield* record()
			const grant = yield* useGrant(current, attempt)
			if (Option.isSome(grant)) {
				if (grant.value.effect === "deny")
					return yield* record({
						allow: false,
						by: grant.value.grantedBy,
						reason: grant.value.reason ?? "A Grant denies this.",
					})
				return Decision.Allow()
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
				if (Arr.every(all, Boolean)) return Decision.Allow()
			}
			return yield* record()
		})
		return CapabilityAccess.of({ member, check, holds, holding, stillHolds })
	})
/** Used only by the old member runtime until its execution cutover. */
export const make = Effect.gen(function* () {
	const grants = yield* Grants
	return yield* makeWith((current, attempt) =>
		Effect.gen(function* () {
			const grant = yield* grants.match({
				organizationId: current.identity.owner.organizationId,
				bot: current.bot.id,
				capability: attempt.capability,
				chat: current.chat,
			})
			if (Option.isNone(grant) || grant.value.effect === "deny") return grant
			return (yield* grants.use(
				current.identity.owner.organizationId,
				grant.value,
			))
				? grant
				: Option.none()
		}),
	)
})

/** Each resumed check keeps its own one-use Grant, while all current policy checks still run. */
export const durable = (fence: Fence, control?: PolicyOrigin.Control) =>
	Effect.gen(function* () {
		const use = yield* GrantUse.make
		return yield* makeWith((_current, attempt) =>
			use.check(fence, attempt.site, attempt.capability, control),
		)
	})

export const layer = Layer.effect(CapabilityAccess, make)
