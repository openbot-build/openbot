/**
 * The services of plugins that `BrowserHost.run` gives to a test. The host
 * gives no service of a plugin, so a probe reads these keys from the plugins
 * that run now. Each plugin of these keys must be on, so a test that turns
 * one of them off cannot use `BrowserHost`.
 */
import { IndexStore } from "@openbot-build/protocol"
import { Authorization } from "@openbot-build/domain"
import { IndexWork } from "@openbot-build/apps-contract/apps/IndexWork"
import { Bots } from "@openbot-build/conversation-contract/bots/Bots"
import { Channels } from "@openbot-build/conversation-contract/channels/Channels"
import { InputCommands } from "@openbot-build/conversation-contract/chats/InputCommands"
import { OpenWork } from "@openbot-build/conversation-contract/chats/OpenWork"
import { Auth } from "@openbot-build/identity-contract/auth/Auth"
import { ModelRegistry } from "@openbot-build/models-contract/ModelRegistry"
import { AppHost } from "@openbot-build/plugin-apps/AppHost"
import { PublicIndex } from "@openbot-build/plugin-apps/AppIndex"
import { Connections } from "@openbot-build/plugin-apps/Connections"
import { Artifacts } from "@openbot-build/plugin-artifacts/Artifacts"
import { ChannelQueue } from "@openbot-build/plugin-channels/ChannelQueue"
import { ComputerProviders } from "@openbot-build/plugin-computers/ComputerProviders"
import { Computers } from "@openbot-build/plugin-computers/Computers"
import { FileTasks } from "@openbot-build/plugin-files/FileTasks"

/** The keys of the services of plugins that the tests read. */
export const keys = [
	Auth,
	Authorization.Auth,
	AppHost,
	Connections,
	IndexWork,
	PublicIndex,
	IndexStore.IndexStore,
	Channels,
	ChannelQueue,
	FileTasks,
	Artifacts,
	Bots,
	ModelRegistry,
	OpenWork,
	InputCommands,
	Computers,
	ComputerProviders,
] as const

/** The services of `keys`. */
export type Services = (typeof keys)[number]["Identifier"]
