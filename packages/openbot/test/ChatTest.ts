import { ChatStoreRepository, MemoryPersistence } from "@openbot-build/core"
import { Store } from "@openbot-build/core"
import { ChatRuntime, type Plugin } from "@openbot-build/core"
import { Effect, Stream } from "effect"
import { type Prompt, type Tool } from "effect/ai"

/** Runs one Turn of a plugin in a new Chat over a store in memory. */
export const ChatTest = <Tools extends Record<string, Tool.Any>, E, R>(
	plugin: Plugin.Plugin<Tools, E, R>,
) => {
	const create = Effect.gen(function* () {
		const definition = yield* Store.define({
			stores: {},
			schemaVersion: "chat/1",
		})
		const runtimeStore = yield* ChatStoreRepository.make({
			definition: definition,
			persistence: yield* MemoryPersistence.make,
		})
		const runtime = yield* ChatRuntime.make({
			store: runtimeStore,
			bot: { plugin: plugin },
		})
		const view = yield* runtimeStore.create({})
		return { runtime, chat: view.chat.id }
	})
	return {
		execute: (input: { input: Prompt.RawInput }) =>
			Effect.scoped(
				Effect.gen(function* () {
					const { runtime, chat } = yield* create
					return yield* runtime.execute({ ...input, chat })
				}),
			),
		stream: (input: { input: Prompt.RawInput }) =>
			Stream.unwrap(
				Effect.gen(function* () {
					const { runtime, chat } = yield* create
					return runtime.stream({ ...input, chat })
				}),
			),
	}
}
