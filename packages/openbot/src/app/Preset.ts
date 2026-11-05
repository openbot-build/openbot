/**
 * The preset: the plugins that OpenBot runs. The entry points of `Host` run
 * all of them, except the plugins that are off by default and those that the
 * plugins file turns off. A plugin in `required` cannot be turned off.
 */
import type * as PresetPlugins from "./PresetPlugins.ts"

/** The ids of the plugins of OpenBot, in the order of their dependencies. */
export const ids = [
	"audit",
	"mail",
	"platform",
	"organization",
	"access",
	"sso",
	"auth",
	"authorization",
	"models",
	"files",
	"bots",
	"capabilities",
	"work",
	"imported",
	"chats",
	"channels",
	"apps",
	"code",
	"vaults",
	"computers",
	"triggers",
	"billing",
	"settings",
	"turn-limiter",
	"time-limiter",
	"token-limiter",
] as const

export type Id = (typeof ids)[number]

/** The module name of a plugin, such as `@openbot-build/plugin-bots`. */
export const nameOf = (id: string) => `@openbot-build/plugin-${id}`

/**
 * These plugins are off until the plugins file turns them on. The limit
 * plugins are here: each one needs its limit as config.
 */
export const offByDefault: ReadonlyArray<Id> = [
	"turn-limiter",
	"time-limiter",
	"token-limiter",
]

/** OpenBot cannot work without these plugins. */
export const required: ReadonlyArray<Id> = [
	"auth",
	"authorization",
	"access",
	"organization",
	"platform",
	"audit",
]

/**
 * The services that the plugins publish. The entry points of `Host` give a
 * snapshot of them, as they are when the host has started.
 */
export type Published = (typeof PresetPlugins.published)[number]["Identifier"]
