import {
	Bot,
	Chat,
	ChatRuntime,
	ChatStore,
	ChatStoreRepository,
	MemoryPersistence,
	Store,
} from "@openbot-build/core"
import { Array as Arr, Effect } from "effect"
import { type Tool } from "effect/ai"

import { modelForBuild } from "./LanguageModelTest.ts"

/**
 * A runtime over a store in memory, and one new Chat.
 * It needs a Scope: the runtime stops when the Scope closes.
 */
export const ChatTest = <
	Tools extends Record<string, Tool.Any> = {},
	E = never,
	R = never,
	BuildE = never,
	BuildR = never,
	HostTools extends Record<string, Tool.Any> = {},
>(
	bot: Bot.Definition<Tools, E, R, BuildE, BuildR, HostTools> = {},
	options: {
		/** Give the same persistence to a second store, as after a restart. */
		readonly persistence?: ChatStore.Persistence
		readonly operations?: typeof import("@openbot-build/core").Operations.Operations.Service
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
		const runtime = yield* ChatRuntime.make({
			store: runtimeStore,
			bot,
			...(options.operations === undefined
				? {}
				: { operations: options.operations }),
		}).pipe(Effect.provide(modelForBuild))
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
 * It has no time limit of its own. The time limit of the test stops it.
 * The one-second wait is a check again under real time. On the test clock it does nothing.
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
				!Arr.some(view.chat.inbox, (entry) => entry.kind === "message")
			)
				return view
			view = yield* runtime.wait({
				chat,
				after: view.chat.revision,
				afterActive: active,
				timeout: "1 second",
			})
		}
	})
