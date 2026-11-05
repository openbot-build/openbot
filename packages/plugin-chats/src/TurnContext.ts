import { Bots as BotDomain, Execution } from "@openbot-build/domain"
import { Effect, Layer, Option } from "effect"
import { Bots } from "@openbot-build/conversation-contract/bots/Bots"
import { Work } from "@openbot-build/conversation-contract/capabilities/Work"
import { Organization } from "@openbot-build/identity-contract/organization/Organization"
import * as ChatHost from "@openbot-build/conversation-contract/chats/ChatHost"
import {
	MemberInactive,
	TurnContext,
} from "@openbot-build/conversation-contract/chats/TurnContext"
export {
	MemberInactive,
	TurnContext,
} from "@openbot-build/conversation-contract/chats/TurnContext"
export type { Failure } from "@openbot-build/conversation-contract/chats/TurnContext"

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
