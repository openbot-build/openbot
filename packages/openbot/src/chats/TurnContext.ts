import type { Chat, Turn } from "@openbot-build/core"
import {
	Bots as BotDomain,
	Execution,
	type ExecutionIdentity,
} from "@openbot-build/domain"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { Bots } from "../bots/Bots.ts"
import { Work } from "../capabilities/Work.ts"
import {
	Organization,
	type OrganizationUnavailable,
} from "../organization/Organization.ts"
import * as ChatHost from "./ChatHost.ts"

/** The owner or actor of a Turn is no longer an active member. */
export class MemberInactive extends Schema.TaggedError<
	MemberInactive,
	{ readonly brand: unique symbol }
>()("TurnContext.MemberInactive", { userId: Schema.String }) {}

export type Failure =
	| BotDomain.BotNotFound
	| BotDomain.BotStorageUnavailable
	| OrganizationUnavailable
	| MemberInactive
	| Execution.Forbidden

/** Builds Work from an accepted Turn or tool frame. Its caller checks the execution fence. */
export class TurnContext extends Context.Service<
	TurnContext,
	{
		readonly prepare: (input: {
			readonly identity: ExecutionIdentity
			readonly namespace: string
			readonly chat: Chat.Id
			readonly host: ChatHost.ChatHostState
			readonly turn: Turn.Id
		}) => Effect.Effect<typeof Work.Service, Failure>
	}
>()("@openbot-build/openbot/chats/TurnContext") {}

export const layer = Layer.effect(
	TurnContext,
	Effect.gen(function* () {
		const bots = yield* Bots
		const organization = yield* Organization
		const active = (organizationId: string, userId: string) =>
			organization.activeMember(organizationId, userId).pipe(
				Effect.flatMap(
					Option.match({
						onNone: () => Effect.fail(MemberInactive.make({ userId })),
						onSome: () => Effect.void,
					}),
				),
			)
		return TurnContext.of({
			prepare: ({ namespace, chat, host: state, turn, identity }) =>
				Effect.gen(function* () {
					if (
						!ChatHost.matchesHost(state, identity) ||
						identity.delegationId !== state.parent?.delegation
					)
						return yield* Execution.Forbidden.make({})
					const chain = ChatHost.chainForHost(state, identity)
					const organizationId = chain.organizationId
					const owner = ChatHost.ownerOf(chain)
					yield* active(organizationId, owner)
					if (chain.userId !== owner)
						yield* active(organizationId, chain.userId)
					const bot = yield* bots.find(organizationId, state.bot).pipe(
						Effect.flatMap(
							Option.match({
								onNone: () =>
									Effect.fail(BotDomain.BotNotFound.make({ bot: state.bot })),
								onSome: Effect.succeed,
							}),
						),
					)
					return Work.of({
						identity,
						namespace,
						bot,
						chain,
						deciders: yield* bots.ownerChain(
							{ organizationId, userId: chain.userId },
							bot,
						),
						chat,
						turn,
					})
				}),
		})
	}),
)
