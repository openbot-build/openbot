import { Context, Effect } from "effect"
import { Chat, ChatStore } from "@openbot-build/core"
import * as Chats from "../chats/Chats.ts"
import type { Caller, Identity } from "@openbot-build/api"

export class Backend extends Context.Service<
	Backend,
	{
		/** The Chats of a namespace. Only its owner may use them. */
		readonly get: (
			namespace: string,
			owner: typeof Identity.Service,
		) => Effect.Effect<
			typeof Chats.Chats.Service,
			ChatStore.ChatStoreError | Chat.ChatError
		>
		/**
		 * The Chats of one member. Members of the same organization do not share Chats.
		 * The runtime acts for the member, never for one of their tokens.
		 */
		readonly forCaller: (
			caller: Caller,
		) => Effect.Effect<
			typeof Chats.Chats.Service,
			ChatStore.ChatStoreError | Chat.ChatError
		>
	}
>()("@openbot-build/openbot/app/Backend") {}
