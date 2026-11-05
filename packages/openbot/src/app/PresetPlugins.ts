/**
 * The plugins of the preset, the entries of the loader, and the check of the
 * required plugins. The host uses this module. It is not public.
 */
import type { Plugin as GraftPlugin } from "@graftland/graft"
import { type Entry, Loader, Tree } from "@graftland/loader"
import AccessPlugin from "@openbot-build/plugin-access"
import AuditPlugin from "@openbot-build/plugin-audit"
import AuthPlugin from "@openbot-build/plugin-auth"
import AuthorizationPlugin from "@openbot-build/plugin-authorization"
import BillingPlugin from "@openbot-build/plugin-billing"
import MailPlugin from "@openbot-build/plugin-mail"
import OrganizationPlugin from "@openbot-build/plugin-organization"
import PlatformPlugin from "@openbot-build/plugin-platform"
import SettingsPlugin from "@openbot-build/plugin-settings"
import SsoPlugin from "@openbot-build/plugin-sso"
import {
	Array as Arr,
	Effect,
	Record as Rec,
	Ref,
	Schema,
	Stream,
} from "effect"
import * as AppsPlugin from "../plugin-apps/Plugin.ts"
import * as BotsPlugin from "../plugin-bots/Plugin.ts"
import * as CapabilitiesPlugin from "../plugin-capabilities/Plugin.ts"
import * as ChannelsPlugin from "../plugin-channels/Plugin.ts"
import * as ChatsPlugin from "../plugin-chats/Plugin.ts"
import * as CodePlugin from "../plugin-code/Plugin.ts"
import * as ComputersPlugin from "../plugin-computers/Plugin.ts"
import * as FilesPlugin from "../plugin-files/Plugin.ts"
import * as ImportedPlugin from "../plugin-imported/Plugin.ts"
import * as ModelsPlugin from "../plugin-models/Plugin.ts"
import * as TriggersPlugin from "../plugin-triggers/Plugin.ts"
import * as VaultsPlugin from "../plugin-vaults/Plugin.ts"
import * as WorkPlugin from "../plugin-work/Plugin.ts"
import * as Feature from "@openbot-build/server-plugin/Feature"
import * as PluginsFile from "./PluginsFile.ts"
import { type Id, ids, nameOf, required } from "./Preset.ts"

/** The plugin of each id. The keys follow the order of `ids`. */
export const byId = {
	audit: AuditPlugin,
	mail: MailPlugin,
	platform: PlatformPlugin,
	organization: OrganizationPlugin,
	access: AccessPlugin,
	sso: SsoPlugin,
	auth: AuthPlugin,
	authorization: AuthorizationPlugin,
	models: ModelsPlugin.default,
	files: FilesPlugin.default,
	bots: BotsPlugin.default,
	capabilities: CapabilitiesPlugin.default,
	work: WorkPlugin.default,
	imported: ImportedPlugin.default,
	chats: ChatsPlugin.default,
	channels: ChannelsPlugin.default,
	apps: AppsPlugin.default,
	code: CodePlugin.default,
	vaults: VaultsPlugin.default,
	computers: ComputersPlugin.default,
	triggers: TriggersPlugin.default,
	billing: BillingPlugin,
	settings: SettingsPlugin,
} as const satisfies Record<Id, GraftPlugin.Plugin>

/**
 * The plugins of OpenBot by module name. The loader resolves the name of an
 * entry with this table.
 */
export const plugins: Readonly<Record<string, GraftPlugin.Plugin>> =
	Rec.fromEntries(Arr.map(ids, (id) => [nameOf(id), byId[id]] as const))

/** One entry for each plugin, in the order of `ids`. */
export const entries: ReadonlyArray<Entry.Entry> = PluginsFile.presetEntries

/** An entry of a required plugin is missing or turned off. */
export class RequiredPluginMissing extends Schema.TaggedError<
	RequiredPluginMissing,
	{ readonly brand: unique symbol }
>()("RequiredPluginMissing", { ids: Schema.Array(Schema.String) }) {
	override get message() {
		return `These plugins are needed and are missing or turned off: ${Arr.join(this.ids, ", ")}`
	}
}

/** Fails when an entry of a required plugin is missing or turned off. */
export const check = (
	entries: ReadonlyArray<Entry.Entry>,
): Effect.Effect<void, RequiredPluginMissing> => {
	const missing = Arr.filter(
		required,
		(id) =>
			!Arr.some(entries, (entry) => entry.id === id && entry.disabled !== true),
	)
	return Arr.isReadonlyArrayNonEmpty(missing)
		? Effect.fail(RequiredPluginMissing.make({ ids: missing }))
		: Effect.void
}

/**
 * Keeps the entries in memory only. It never reads or writes a file, and it
 * sees no change from outside. An edit that would remove or turn off a
 * required plugin fails with a `StoreError` whose cause is
 * `RequiredPluginMissing`. An edit that breaks another rule of
 * `PluginsFile.checkEntries`, such as a new name for a preset plugin, fails
 * with a `StoreError` whose cause is `EntriesInvalid`.
 */
export const store = (
	initial: ReadonlyArray<Entry.Entry>,
	known: PluginsFile.Known,
) =>
	Effect.map(Ref.make(initial), (current): Loader.Store => ({
		initial,
		apply: (op) =>
			Ref.get(current).pipe(
				Effect.flatMap((tree) => Effect.fromResult(Tree.apply(tree, op))),
				Effect.tap((next) =>
					check(next).pipe(
						Effect.mapError((cause) => Loader.StoreError.make({ cause })),
					),
				),
				Effect.tap((next) => {
					const problems = PluginsFile.checkEntries(known, next)
					return Arr.isReadonlyArrayNonEmpty(problems)
						? Effect.fail(
								Loader.StoreError.make({
									cause: PluginsFile.EntriesInvalid.make({ problems }),
								}),
							)
						: Effect.void
				}),
				Effect.tap((next) => Ref.set(current, next)),
			),
		refresh: Effect.succeedNone,
		external: Stream.never,
	}))

/** The keys that the plugins publish, read from each plugin. */
export const published = [
	...Feature.published(byId.audit),
	...Feature.published(byId.mail),
	...Feature.published(byId.platform),
	...Feature.published(byId.organization),
	...Feature.published(byId.access),
	...Feature.published(byId.sso),
	...Feature.published(byId.auth),
	...Feature.published(byId.authorization),
	...Feature.published(byId.models),
	...Feature.published(byId.files),
	...Feature.published(byId.bots),
	...Feature.published(byId.capabilities),
	...Feature.published(byId.work),
	...Feature.published(byId.imported),
	...Feature.published(byId.chats),
	...Feature.published(byId.channels),
	...Feature.published(byId.apps),
	...Feature.published(byId.code),
	...Feature.published(byId.vaults),
	...Feature.published(byId.computers),
	...Feature.published(byId.triggers),
	...Feature.published(byId.billing),
	...Feature.published(byId.settings),
] as const
