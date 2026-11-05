/** The settings plugin: the settings of each member. */
import { Bots } from "@openbot-build/conversation-contract/bots/Bots"
import { Settings } from "@openbot-build/server-kernel/settings/Settings"
import * as Feature from "@openbot-build/server-plugin/Feature"
import * as HttpMounts from "./HttpMounts.ts"

export default Feature.make("@openbot-build/plugin-settings").start({
	inject: [...HttpMounts.inject, Bots, Settings],
	layer: HttpMounts.layer,
})
