import { SessionStoreRepository, MemoryPersistence } from "@openbot-build/core"
import { TimelineState, Store } from "@openbot-build/core"
import { SessionRuntime, type Plugin } from "@openbot-build/core"
import { Effect, Stream } from "effect"
import { type Prompt, type Tool } from "effect/ai"

export const SessionTest = <Tools extends Record<string, Tool.Any>, E, R>(
	plugin: Plugin.Plugin<Tools, E, R>,
) => {
	const create = Effect.gen(function* () {
		const definition = yield* Store.define({
			stores: {},
			schemaVersion: "timeline/1",
		})
		const runtimeStore = yield* SessionStoreRepository.make({
			definition: definition,
			persistence: yield* MemoryPersistence.make,
		})
		const runtime = yield* SessionRuntime.make({
			store: runtimeStore,
			agent: { plugin: plugin },
		})
		const view = yield* runtimeStore.create({
			metadata: {},
			value: TimelineState.initial({}),
		})
		return {
			runtime,
			base: { session: view.session.id, revision: view.session.revision },
		}
	})
	return {
		execute: (input: { input: Prompt.RawInput }) =>
			Effect.scoped(
				Effect.gen(function* () {
					const { runtime, base } = yield* create
					return yield* runtime.execute({ ...input, base })
				}),
			),
		stream: (input: { input: Prompt.RawInput }) =>
			Stream.unwrap(
				Effect.gen(function* () {
					const { runtime, base } = yield* create
					return runtime.stream({ ...input, base })
				}),
			),
	}
}
