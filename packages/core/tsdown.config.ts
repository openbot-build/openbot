import config from "../../tsdown.config.ts"
import { defineConfig } from "tsdown"

export default defineConfig({
	...config,
	entry: {
		"bot/Bot": "src/bot/Bot.ts",
		"session/Turn": "src/session/Turn.ts",
		"timeline/Timeline": "src/timeline/Timeline.ts",
		"timeline/Item": "src/timeline/Item.ts",
		"store/SessionStoreRepository": "src/store/SessionStoreRepository.ts",
		"store/Snapshots": "src/store/Snapshots.ts",
		"store/Store": "src/store/Store.ts",
		"store/RecordSerialization": "src/store/RecordSerialization.ts",
		"store/MemoryPersistence": "src/store/MemoryPersistence.ts",
		"store/VersionGraph": "src/store/VersionGraph.ts",
		"store/DeltaValidation": "src/store/DeltaValidation.ts",
		"timeline/TimelineState": "src/timeline/TimelineState.ts",

		index: "src/index.ts",
		"session/Session": "src/session/Session.ts",
		"models/Config": "src/models/Config.ts",
		"context/ConversationContext": "src/context/ConversationContext.ts",
		"models/Model": "src/models/Model.ts",
		"plugins/Plugin": "src/plugins/Plugin.ts",
		"models/Provider": "src/models/Provider.ts",
		"skills/Skill": "src/skills/Skill.ts",
		"skills/SkillMap": "src/skills/SkillMap.ts",
		"store/SessionStore": "src/store/SessionStore.ts",
		"session/SessionRuntime": "src/session/SessionRuntime.ts",
		"store/SessionStoreMemory": "src/store/SessionStoreMemory.ts",
		"models/ConfigurationOperations": "src/models/ConfigurationOperations.ts",
		"context/ContextWindow": "src/context/ContextWindow.ts",
		"context/SummaryCompaction": "src/context/SummaryCompaction.ts",
		"context/ContextCompaction": "src/context/ContextCompaction.ts",
		"context/ConversationContextOperations":
			"src/context/ConversationContextOperations.ts",
		"plugins/PluginComposition": "src/plugins/PluginComposition.ts",
		"plugins/PluginState": "src/plugins/PluginState.ts",
	},
	exports: {
		...config.exports,
		customExports(exports) {
			return Object.fromEntries(
				Object.entries(exports).map(([key, value]) => {
					const name = key.split("/").at(-1)
					return [
						key === "."
							? key
							: `./${name === "Snapshots" ? "TimelineSnapshots" : name}`,
						value,
					]
				}),
			)
		},
	},
})
