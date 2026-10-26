import type { Chat } from "@openbot-build/core"
import {
	Context,
	Effect,
	HashMap,
	Layer,
	SynchronizedRef,
	Option,
	type Scope,
} from "effect"
import type { LanguageModel } from "effect/ai"

export interface Ownership {
	readonly generation: number
	readonly sessionId: string
	readonly check: Effect.Effect<boolean>
}

interface Entry {
	readonly model: LanguageModel.LanguageModel
	readonly ownership?: Ownership
}

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
			ownership?: Ownership,
		) => Effect.Effect<boolean, never, Scope.Scope>
		readonly find: (
			chat: Chat.Id,
			generation?: number,
		) => Effect.Effect<Option.Option<LanguageModel.LanguageModel>>
		readonly has: (
			chat: Chat.Id,
			generation?: number,
			sessionId?: string,
		) => Effect.Effect<boolean>
	}
>()("@openbot-build/openbot/chats/live/LiveSessions") {}

export const make = Effect.gen(function* () {
	const open = yield* SynchronizedRef.make(HashMap.empty<Chat.Id, Entry>())
	const find = (chat: Chat.Id, generation?: number) =>
		Effect.gen(function* () {
			const entry = HashMap.get(yield* SynchronizedRef.get(open), chat)
			if (Option.isNone(entry))
				return Option.none<LanguageModel.LanguageModel>()
			const owner = entry.value.ownership
			if (
				owner !== undefined &&
				((generation !== undefined && owner.generation !== generation) ||
					!(yield* owner.check))
			)
				return Option.none<LanguageModel.LanguageModel>()
			return Option.some(entry.value.model)
		})
	return LiveSessions.of({
		register: (chat, model, ownership) => {
			const entry: Entry = {
				model,
				...(ownership === undefined ? {} : { ownership }),
			}
			return Effect.acquireRelease(
				SynchronizedRef.modifyEffect(open, (map) =>
					Effect.gen(function* () {
						const previous = HashMap.get(map, chat)
						if (
							Option.isSome(previous) &&
							(previous.value.ownership === undefined ||
								(yield* previous.value.ownership.check))
						)
							return [false, map] as const
						return [true, HashMap.set(map, chat, entry)] as const
					}),
				),
				(added) =>
					added
						? SynchronizedRef.update(open, (map) =>
								Option.getOrUndefined(HashMap.get(map, chat)) === entry
									? HashMap.remove(map, chat)
									: map,
							)
						: Effect.void,
			)
		},
		find,
		// Admission also checks the stored lease under the Chat revision lock.
		has: (chat, generation, sessionId) =>
			SynchronizedRef.get(open).pipe(
				Effect.map((map) => {
					const entry = HashMap.get(map, chat)
					return (
						Option.isSome(entry) &&
						(generation === undefined ||
							entry.value.ownership?.generation === generation) &&
						(sessionId === undefined ||
							entry.value.ownership?.sessionId === sessionId)
					)
				}),
			),
	})
})

export const layer = Layer.effect(LiveSessions, make)
