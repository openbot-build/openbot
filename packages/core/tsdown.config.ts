import config from "../../tsdown.config.ts"
import { defineConfig } from "tsdown"

export default defineConfig({
	...config,
	entry: {
		"bot/Bot": "src/bot/Bot.ts",
		"chat/Turn": "src/chat/Turn.ts",
		"chat/Operation": "src/chat/Operation.ts",
		"chat/Operations": "src/chat/Operations.ts",
		"chat/Item": "src/chat/Item.ts",
		"chat/ChatState": "src/chat/ChatState.ts",
		"store/ChatStoreRepository": "src/store/ChatStoreRepository.ts",
		"store/Store": "src/store/Store.ts",
		"store/MemoryPersistence": "src/store/MemoryPersistence.ts",

		index: "src/index.ts",
		"chat/Chat": "src/chat/Chat.ts",
		"models/Config": "src/models/Config.ts",
		"models/Live": "src/models/Live.ts",
		"models/LiveDriver": "src/models/LiveDriver.ts",
		"models/Model": "src/models/Model.ts",
		"plugins/Plugin": "src/plugins/Plugin.ts",
		"models/Provider": "src/models/Provider.ts",
		"skills/Skill": "src/skills/Skill.ts",
		"skills/SkillMap": "src/skills/SkillMap.ts",
		"store/ChatStore": "src/store/ChatStore.ts",
		"chat/ChatRuntime": "src/chat/ChatRuntime.ts",
		"store/ChatStoreMemory": "src/store/ChatStoreMemory.ts",
		"models/ConfigurationOperations": "src/models/ConfigurationOperations.ts",
		"context/ContextWindow": "src/context/ContextWindow.ts",
		"context/SummaryCompaction": "src/context/SummaryCompaction.ts",
		"context/ContextCompaction": "src/context/ContextCompaction.ts",
		"plugins/PluginComposition": "src/plugins/PluginComposition.ts",
		"plugins/PluginState": "src/plugins/PluginState.ts",
	},
	exports: {
		...config.exports,
		customExports(exports) {
			return Object.fromEntries(
				Object.entries(exports).map(([key, value]) => [
					key === "." ? key : `./${key.split("/").at(-1)}`,
					value,
				]),
			)
		},
	},
})
