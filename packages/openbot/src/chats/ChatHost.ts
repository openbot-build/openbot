import { Chat, type Plugin, type Turn } from "@openbot-build/core"
import { Caller, Execution, TokenId } from "@openbot-build/domain"
import {
	Bots as BotsApi,
	ChatKind,
	ChatParent,
	PlanApproval,
	type ExecutionIdentity,
} from "@openbot-build/domain"
import type * as Todos from "../plugins/work/Todos.ts"
import { Option, Schema, String as Str } from "effect"

/** The OpenBot plugin that adds the host toolkit, the user plugin and the execution services. */
const chatHostKey = "@openbot-build/openbot/chat-host"
export const chatHostId = Schema.Literal(chatHostKey)
	.pipe(Schema.brand("@openbot-build/core/PluginId"))
	.make(chatHostKey)

/**
 * Who the work in a Chat is for, and through which Bots it came.
 * `bots` starts with the Bot that the person or client called, and ends with the Bot of this Chat.
 * `chats` lists the Chats before this one, in the same order.
 * The same Bot can come twice, when a Bot gives work to itself, so look things up by place.
 */
export const Chain = Schema.Struct({
	organizationId: Schema.String,
	userId: Schema.String,
	/** The token that started the work, when a token did. The work never does more than it may. */
	tokenId: Schema.optionalKey(TokenId),
	/**
	 * The member whose Chats hold the work, when it is not `userId`. In a chat Channel,
	 * the Chats belong to the actor of the Channel, and each Turn works for its speaker.
	 */
	owner: Schema.optionalKey(Schema.String),
	bots: Schema.Array(BotsApi.BotId),
	chats: Schema.Array(Chat.Id),
})
export type Chain = typeof Chain.Type

/** OpenBot data for one Chat. */
export const ChatHostState = Schema.Struct({
	bot: BotsApi.BotId,
	kind: ChatKind,
	parent: Schema.optionalKey(ChatParent),
	/** The workflow that owns this Chat and all accepted follow-up work. */
	ownerExecutionId: Schema.optionalKey(Execution.Id),
	/** Task inputs keep all caller limits. Other Chat kinds do not share these limits. */
	inputConstraints: Schema.optionalKey(Schema.Array(Caller)),
	chain: Chain,
	/** The request that a review Chat decides. */
	review: Schema.optionalKey(Schema.String),
	/** True when a review Chat has decided, so it is not used again. */
	closed: Schema.optionalKey(Schema.Boolean),
	/** New work waits until this saved stop or delete command ends. */
	control: Schema.optionalKey(Execution.Id),
	/** The trigger that gave the work of a task Chat. */
	trigger: Schema.optionalKey(Schema.String),
	/**
	 * The chat of a Channel that a channel Chat belongs to. `group` is true for a chat
	 * with many people. Chats from before it was kept count as groups, because that is safer.
	 */
	channel: Schema.optionalKey(
		Schema.Struct({
			channel: Schema.String,
			conversation: Schema.String,
			group: Schema.optionalKey(Schema.Boolean),
		}),
	),
	/** The name of the chat on the platform of a Channel. */
	title: Schema.optionalKey(Schema.String),
	/** How plans in this Chat are approved, when the Chat sets it. */
	planApproval: Schema.optionalKey(PlanApproval.PlanApproval),
})
export type ChatHostState = typeof ChatHostState.Type
/** The plugin data in a Chat: the todo list and the OpenBot data. */
export type Values = Todos.Values & {
	readonly [chatHostKey]?: ChatHostState
}
export const chatHostStore = {
	scope: "record",
	schema: Schema.toCodecJson(ChatHostState),
} satisfies Plugin.StoreDefinition<
	ReturnType<typeof Schema.toCodecJson<typeof ChatHostState>>
>

/**
 * The OpenBot data of a Chat. The store checks it with chatHostStore when it loads.
 * OpenBot writes it when it makes the Chat, so every Chat has it.
 */
export const hostState = (chat: Chat.Ref): ChatHostState =>
	chat.business[chatHostId] as ChatHostState

/**
 * The author of input. A person who works through a token is a different author than
 * the same person without it, so input through a token never steers a Turn that works
 * with more rights.
 */
export const authorOf = (userId: string, tokenId?: string): Turn.Author =>
	tokenId === undefined ? userId : userId + "#" + tokenId

/** The member and the token of an author. */
export const parseAuthor = (
	author: Turn.Author,
): { readonly userId: string; readonly tokenId?: TokenId } =>
	Option.match(Str.indexOf("#")(author), {
		onNone: () => ({ userId: author }),
		onSome: (at) => ({
			userId: Str.slice(0, at)(author),
			tokenId: TokenId.make(Str.slice(at + 1)(author)),
		}),
	})

/**
 * Who one Turn works for. A Turn with an author, such as a speaker in a chat Channel,
 * works for that member and not for the owner of the Chat. It never uses the token
 * of the owner. A Turn without an author works for the member of the chain.
 */
export const turnChain = (
	chat: Chat.Ref,
	author: Turn.Author | undefined,
): Chain => {
	const chain = hostState(chat).chain
	if (author === undefined) return chain
	const { userId, tokenId } = parseAuthor(author)
	return {
		organizationId: chain.organizationId,
		userId,
		...(tokenId === undefined ? {} : { tokenId }),
		...(userId === chain.userId && chain.owner === undefined
			? {}
			: { owner: ownerOf(chain) }),
		bots: chain.bots,
		chats: chain.chats,
	}
}

/** The author of the work of a chain: its member, and its token when it has one. */
export const chainAuthor = (chain: Chain): Turn.Author =>
	authorOf(chain.userId, chain.tokenId)

/** The member whose Chats hold the work of a chain. */
export const ownerOf = (chain: Chain) => chain.owner ?? chain.userId

/** The owner and actor of one Turn. A token never becomes the owner. */
export const identityOf = (
	chat: Chat.Ref,
	author?: Turn.Author,
): ExecutionIdentity => {
	const state = hostState(chat)
	const chain = turnChain(chat, author)
	const actor =
		chain.tokenId === undefined
			? {
					kind: "member" as const,
					organizationId: chain.organizationId,
					userId: chain.userId,
				}
			: {
					kind: "user_token" as const,
					organizationId: chain.organizationId,
					userId: chain.userId,
					tokenId: chain.tokenId,
				}
	return {
		owner: { organizationId: chain.organizationId, userId: ownerOf(chain) },
		actor,
		botId: state.bot,
		...(state.parent === undefined
			? {}
			: { delegationId: state.parent.delegation }),
	}
}

/** The execution must name the same resource owner and Bot as the Chat. */
export const matchesIdentity = (
	chat: Chat.Ref,
	identity: ExecutionIdentity,
): boolean => matchesHost(hostState(chat), identity)

export const matchesHost = (
	state: ChatHostState,
	identity: ExecutionIdentity,
): boolean =>
	identity.owner.organizationId === state.chain.organizationId &&
	identity.owner.userId === ownerOf(state.chain) &&
	identity.actor.organizationId === state.chain.organizationId &&
	identity.botId === state.bot

/** The execution gives the actor. The Chat gives only the stored path of delegation. */
export const chainForIdentity = (
	chat: Chat.Ref,
	identity: ExecutionIdentity,
): Chain => chainForHost(hostState(chat), identity)

export const chainForHost = (
	state: ChatHostState,
	identity: ExecutionIdentity,
): Chain => ({
	organizationId: identity.owner.organizationId,
	userId: identity.actor.userId,
	...(identity.actor.tokenId === undefined
		? {}
		: { tokenId: identity.actor.tokenId }),
	...(identity.owner.userId === identity.actor.userId
		? {}
		: { owner: identity.owner.userId }),
	bots: state.chain.bots,
	chats: state.chain.chats,
})
