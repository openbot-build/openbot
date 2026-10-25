import type { Chat } from "@openbot-build/core"
import {
	Context,
	Effect,
	HashMap,
	Layer,
	SynchronizedRef,
	type Option,
	type Scope,
} from "effect"
import type { LanguageModel } from "effect/ai"

/**
 * The open Live sessions of this process, one for each live Chat. While a session is
 * open, the Turns of its Chat run in this process with the model of the session. Other
 * processes do not start Turns in the Chat.
 */
export class LiveSessions extends Context.Service<
	LiveSessions,
	{
		/**
		 * Gives the model to the Turns of the Chat until the Scope closes. It is false
		 * when the Chat already has an open session in this process.
		 */
		readonly register: (
			chat: Chat.Id,
			model: LanguageModel.LanguageModel,
		) => Effect.Effect<boolean, never, Scope.Scope>
		readonly find: (
			chat: Chat.Id,
		) => Effect.Effect<Option.Option<LanguageModel.LanguageModel>>
		readonly has: (chat: Chat.Id) => Effect.Effect<boolean>
	}
>()("@openbot-build/openbot/chats/live/LiveSessions") {}

export const make = Effect.gen(function* () {
	const open = yield* SynchronizedRef.make(
		HashMap.empty<Chat.Id, LanguageModel.LanguageModel>(),
	)
	return LiveSessions.of({
		register: (chat, model) =>
			Effect.acquireRelease(
				SynchronizedRef.modify(open, (map) =>
					HashMap.has(map, chat)
						? [false, map]
						: [true, HashMap.set(map, chat, model)],
				),
				(added) =>
					added
						? SynchronizedRef.update(open, HashMap.remove(chat))
						: Effect.void,
			),
		find: (chat) =>
			SynchronizedRef.get(open).pipe(Effect.map(HashMap.get(chat))),
		has: (chat) =>
			SynchronizedRef.get(open).pipe(Effect.map(HashMap.has(chat))),
	})
})

export const layer = Layer.effect(LiveSessions, make)
