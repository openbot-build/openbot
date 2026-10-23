import {
	Bot,
	Chat,
	ChatRuntime,
	ChatStore,
	ChatStoreRepository,
	MemoryPersistence,
	Store,
} from "@openbot-build/core"
import { Effect } from "effect"
import { type Tool } from "effect/ai"

/** A runtime over a store in memory, and one new Chat. */
export const ChatTest = <
	Tools extends Record<string, Tool.Any> = {},
	E = never,
	R = never,
	BuildE = never,
	BuildR = never,
>(
	bot: Bot.Definition<Tools, E, R, BuildE, BuildR> = {},
	options: {
		/** Give the same persistence to a second store, as after a restart. */
		readonly persistence?: ChatStore.Persistence
	} = {},
) =>
	Effect.gen(function* () {
		const definition = yield* Store.define({
			stores: {},
			schemaVersion: "chat/1",
		})
		const persistence = options.persistence ?? (yield* MemoryPersistence.make)
		const runtimeStore = yield* ChatStoreRepository.make({
			definition,
			persistence,
		})
		const runtime = yield* ChatRuntime.make({ store: runtimeStore, bot })
		const view = yield* runtimeStore.create({})
		return {
			definition,
			persistence,
			runtime,
			runtimeStore,
			view,
			chat: view.chat.id,
		}
	})

/**
 * Waits until no Turn runs in the Chat and no message waits in its inbox.
 * It fails when that does not happen in five seconds.
 */
export const settled = <P>(
	runtime: Pick<Chat.Runtime<P>, "status" | "isActive" | "wait">,
	chat: Chat.Id,
) =>
	Effect.gen(function* () {
		let view = yield* runtime.status(chat)
		while (true) {
			const active = yield* runtime.isActive(chat)
			if (
				!active &&
				Chat.status(view.chat)._tag !== "Running" &&
				!view.chat.inbox.some((entry) => entry.kind === "message")
			)
				return view
			view = yield* runtime.wait({
				chat,
				after: view.chat.revision,
				afterActive: active,
				timeout: "1 second",
			})
		}
	}).pipe(
		Effect.timeoutOrElse({
			duration: "5 seconds",
			orElse: () => Effect.die("The Chat did not come to rest in time"),
		}),
	)
