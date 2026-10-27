import type { Chat, Item } from "@openbot-build/core"
import type { ExecutionIdentity } from "@openbot-build/domain"
import { Array as Arr, HashSet, String as Str } from "effect"
import type { Prompt } from "effect/ai"
import * as ChatHost from "../chats/ChatHost.ts"
import * as Audience from "../plugins/memory/Audience.ts"
import type * as Memory from "../plugins/memory/BotMemory.ts"

export const textOf = (message: Prompt.Message): string => {
	if (typeof message.content === "string") return message.content
	const parts: ReadonlyArray<Prompt.Part> = message.content
	return Arr.join(
		Arr.flatMap(parts, (part) => (part.type === "text" ? [part.text] : [])),
		"\n",
	)
}

export const viewer = (
	chat: Chat.Ref,
	identity: ExecutionIdentity,
): Audience.Viewer => {
	const channel = ChatHost.hostState(chat).channel
	return channel !== undefined && channel.group !== false
		? {
				organizationId: identity.actor.organizationId,
				channel: channel.channel,
			}
		: {
				organizationId: identity.actor.organizationId,
				person: identity.actor.userId,
			}
}

/** An Item gets its author from its saved execution, never from an opaque Turn author. */
export const evidence = (
	chat: Chat.Ref,
	item: Item.Record,
	identity: ExecutionIdentity,
	own: HashSet.HashSet<string>,
): ReadonlyArray<Memory.Evidence> => {
	if (item.origin?.notice !== undefined) return []
	const channel = ChatHost.hostState(chat).channel
	const base = {
		source: { chat: chat.id, item: item.id },
		author: identity.actor.userId,
		organizationId: identity.actor.organizationId,
		audience:
			channel !== undefined && channel.group !== false
				? Audience.channel(channel.channel)
				: Audience.person(identity.actor.userId),
		...(channel === undefined ? {} : { channel: channel.channel }),
	}
	return Arr.flatMap(
		item.content.content,
		(message): ReadonlyArray<Memory.Evidence> => {
			if (message.role === "user" || message.role === "assistant") {
				const text = textOf(message)
				return text.length === 0
					? []
					: [{ ...base, role: message.role, outside: false, text }]
			}
			if (message.role !== "tool") return []
			return Arr.flatMap(message.content, (part) =>
				part.type === "tool-result" && part.name !== "confide"
					? [
							{
								...base,
								role: "tool" as const,
								outside: !HashSet.has(own, part.name),
								tool: part.name,
								text: Str.takeLeft(JSON.stringify(part.result), 2000),
							},
						]
					: [],
			)
		},
	)
}
