import {
	Agent,
	MemoryPersistence,
	SessionRuntime,
	SessionStoreRepository,
	Store,
	type Plugin,
} from "@openbot-build/core"
import { Effect } from "effect"
import { type Tool } from "effect/ai"
export const pluginId = (name: string): Plugin.Id => name as Plugin.Id
export const SessionTest = <
	Tools extends Record<string, Tool.Any> = {},
	E = never,
	R = never,
	BuildE = never,
	BuildR = never,
>(
	agent: Agent.Definition<Tools, E, R, BuildE, BuildR> = {},
) =>
	Effect.gen(function* () {
		const definition = yield* Store.define({
			stores: {},
			schemaVersion: "memory/1",
		})
		const runtimeStore = yield* SessionStoreRepository.make({
			definition,
			persistence: yield* MemoryPersistence.make,
		})
		const runtime = yield* SessionRuntime.make({ store: runtimeStore, agent })
		const view = yield* runtimeStore.create({ metadata: {} })
		return {
			definition,
			runtime,
			runtimeStore,
			view,
			base: { session: view.session.id, revision: view.session.revision },
		}
	})
