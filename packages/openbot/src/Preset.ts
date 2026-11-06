/**
 * The preset: the plugins that OpenBot runs. `Host` runs all of them, except
 * the plugins that are off by default and those that the plugins file turns
 * off. A plugin that is `required` cannot be turned off.
 */
import type { Plugin as GraftPlugin } from "@graftland/graft"
import type { Entry } from "@graftland/loader"
import AccessPlugin from "@openbot-build/plugin-access"
import AppsPlugin from "@openbot-build/plugin-apps"
import ArtifactsPlugin from "@openbot-build/plugin-artifacts"
import AuditPlugin from "@openbot-build/plugin-audit"
import AuthPlugin from "@openbot-build/plugin-auth"
import AuthorizationPlugin from "@openbot-build/plugin-authorization"
import BillingPlugin from "@openbot-build/plugin-billing"
import BotsPlugin from "@openbot-build/plugin-bots"
import CapabilitiesPlugin from "@openbot-build/plugin-capabilities"
import ChannelsPlugin from "@openbot-build/plugin-channels"
import ChatsPlugin from "@openbot-build/plugin-chats"
import CodePlugin from "@openbot-build/plugin-code"
import ComputersPlugin from "@openbot-build/plugin-computers"
import FilesPlugin from "@openbot-build/plugin-files"
import MailPlugin from "@openbot-build/plugin-mail"
import ModelsPlugin from "@openbot-build/plugin-models"
import OrganizationPlugin from "@openbot-build/plugin-organization"
import PlatformPlugin from "@openbot-build/plugin-platform"
import SettingsPlugin from "@openbot-build/plugin-settings"
import SsoPlugin from "@openbot-build/plugin-sso"
import TimeLimiterPlugin from "@openbot-build/plugin-time-limiter"
import TokenLimiterPlugin from "@openbot-build/plugin-token-limiter"
import TriggersPlugin from "@openbot-build/plugin-triggers"
import TurnLimiterPlugin from "@openbot-build/plugin-turn-limiter"
import VaultsPlugin from "@openbot-build/plugin-vaults"
import WorkPlugin from "@openbot-build/plugin-work"
import { Array as Arr, Record as Rec, Result } from "effect"

/** One plugin of the preset. */
export interface Plugin {
	/** The module name of the plugin. An entry names the plugin with it. */
	readonly name: string
	readonly plugin: GraftPlugin.Plugin
	/** OpenBot cannot work without it, so it cannot be turned off. */
	readonly required?: true | undefined
	/** It is off until the plugins file turns it on. */
	readonly disabled?: true | undefined
	/** The plugins file can give it config. */
	readonly configurable?: true | undefined
}

/** The id of a plugin of the preset, such as `bots`. */
export type Id =
	| "audit"
	| "mail"
	| "platform"
	| "organization"
	| "access"
	| "sso"
	| "auth"
	| "authorization"
	| "models"
	| "files"
	| "bots"
	| "capabilities"
	| "work"
	| "chats"
	| "channels"
	| "apps"
	| "code"
	| "vaults"
	| "computers"
	| "artifacts"
	| "triggers"
	| "billing"
	| "settings"
	| "turn-limiter"
	| "time-limiter"
	| "token-limiter"

/**
 * The plugins of OpenBot by id, in the order of their dependencies. The limit
 * plugins are off by default: each one needs its limit as config. The type
 * names only `Plugin`, so the declaration of this module does not name the
 * inside modules of each plugin.
 */
export const plugins: { readonly [K in Id]: Plugin } = {
	audit: {
		name: "@openbot-build/plugin-audit",
		plugin: AuditPlugin,
		required: true,
	},
	mail: { name: "@openbot-build/plugin-mail", plugin: MailPlugin },
	platform: {
		name: "@openbot-build/plugin-platform",
		plugin: PlatformPlugin,
		required: true,
	},
	organization: {
		name: "@openbot-build/plugin-organization",
		plugin: OrganizationPlugin,
		required: true,
	},
	access: {
		name: "@openbot-build/plugin-access",
		plugin: AccessPlugin,
		required: true,
	},
	sso: { name: "@openbot-build/plugin-sso", plugin: SsoPlugin },
	auth: {
		name: "@openbot-build/plugin-auth",
		plugin: AuthPlugin,
		required: true,
	},
	authorization: {
		name: "@openbot-build/plugin-authorization",
		plugin: AuthorizationPlugin,
		required: true,
	},
	models: { name: "@openbot-build/plugin-models", plugin: ModelsPlugin },
	files: { name: "@openbot-build/plugin-files", plugin: FilesPlugin },
	bots: { name: "@openbot-build/plugin-bots", plugin: BotsPlugin },
	capabilities: {
		name: "@openbot-build/plugin-capabilities",
		plugin: CapabilitiesPlugin,
	},
	work: { name: "@openbot-build/plugin-work", plugin: WorkPlugin },
	chats: { name: "@openbot-build/plugin-chats", plugin: ChatsPlugin },
	channels: { name: "@openbot-build/plugin-channels", plugin: ChannelsPlugin },
	apps: {
		name: "@openbot-build/plugin-apps",
		plugin: AppsPlugin,
		configurable: true,
	},
	code: { name: "@openbot-build/plugin-code", plugin: CodePlugin },
	vaults: { name: "@openbot-build/plugin-vaults", plugin: VaultsPlugin },
	computers: {
		name: "@openbot-build/plugin-computers",
		plugin: ComputersPlugin,
	},
	artifacts: {
		name: "@openbot-build/plugin-artifacts",
		plugin: ArtifactsPlugin,
	},
	triggers: { name: "@openbot-build/plugin-triggers", plugin: TriggersPlugin },
	billing: { name: "@openbot-build/plugin-billing", plugin: BillingPlugin },
	settings: { name: "@openbot-build/plugin-settings", plugin: SettingsPlugin },
	"turn-limiter": {
		name: "@openbot-build/plugin-turn-limiter",
		plugin: TurnLimiterPlugin,
		disabled: true,
		configurable: true,
	},
	"time-limiter": {
		name: "@openbot-build/plugin-time-limiter",
		plugin: TimeLimiterPlugin,
		disabled: true,
		configurable: true,
	},
	"token-limiter": {
		name: "@openbot-build/plugin-token-limiter",
		plugin: TokenLimiterPlugin,
		disabled: true,
		configurable: true,
	},
}

/** The plugins of the table as a list of ids and plugins, in the order of the table. */
const table: ReadonlyArray<readonly [Id, Plugin]> = Rec.toEntries(plugins)

/** One entry of the loader for each plugin, in the order of the table. */
export const entries: ReadonlyArray<Entry.Entry> = Arr.map(
	table,
	([id, plugin]) => ({
		id,
		name: plugin.name,
		...(plugin.disabled === true ? { disabled: true } : {}),
	}),
)

/** The ids of the plugins that cannot be turned off. */
export const required: ReadonlyArray<Id> = Arr.filterMap(
	table,
	([id, plugin]) =>
		plugin.required === true ? Result.succeed(id) : Result.failVoid,
)
