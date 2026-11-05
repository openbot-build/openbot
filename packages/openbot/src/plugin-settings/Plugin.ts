/** The settings plugin: the settings of each member. */
import { Bots } from "../conversation-contract/bots/Bots.ts"
import { Settings } from "@openbot-build/server-kernel/settings/Settings"
import * as Feature from "@openbot-build/server-plugin/Feature"
import * as HttpMounts from "./HttpMounts.ts"

export const id = "settings"

/** The keys that this plugin publishes. It publishes none. */
export const publishes = [] as const

export default Feature.make("@openbot-build/plugin-settings").start({
	inject: [...HttpMounts.inject, Bots, Settings],
	layer: HttpMounts.layer,
})
