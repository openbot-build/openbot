/**
 * The plugins of the preset, the entries of the loader, and the check of the
 * required plugins. The host uses this module. It is not public.
 */
import type { Plugin as GraftPlugin } from "@graftland/graft"
import { type Entry, Loader, Tree } from "@graftland/loader"
import {
	Array as Arr,
	Effect,
	Record as Rec,
	Ref,
	Schema,
	Stream,
} from "effect"
import * as AccessPlugin from "../plugin-access/Plugin.ts"
import * as AppsPlugin from "../plugin-apps/Plugin.ts"
import * as AuditPlugin from "../plugin-audit/Plugin.ts"
import * as AuthPlugin from "../plugin-auth/Plugin.ts"
import * as AuthorizationPlugin from "../plugin-authorization/Plugin.ts"
import * as BillingPlugin from "../plugin-billing/Plugin.ts"
import * as BotsPlugin from "../plugin-bots/Plugin.ts"
import * as CapabilitiesPlugin from "../plugin-capabilities/Plugin.ts"
import * as ChannelsPlugin from "../plugin-channels/Plugin.ts"
import * as ChatsPlugin from "../plugin-chats/Plugin.ts"
import * as CodePlugin from "../plugin-code/Plugin.ts"
import * as ComputersPlugin from "../plugin-computers/Plugin.ts"
import * as FilesPlugin from "../plugin-files/Plugin.ts"
import * as ImportedPlugin from "../plugin-imported/Plugin.ts"
import * as MailPlugin from "../plugin-mail/Plugin.ts"
import * as ModelsPlugin from "../plugin-models/Plugin.ts"
import * as OrganizationPlugin from "../plugin-organization/Plugin.ts"
import * as PlatformPlugin from "../plugin-platform/Plugin.ts"
import * as SettingsPlugin from "../plugin-settings/Plugin.ts"
import * as SsoPlugin from "../plugin-sso/Plugin.ts"
import * as TriggersPlugin from "../plugin-triggers/Plugin.ts"
import * as VaultsPlugin from "../plugin-vaults/Plugin.ts"
import * as WorkPlugin from "../plugin-work/Plugin.ts"

import * as PluginsFile from "./PluginsFile.ts"
import { nameOf, required } from "./Preset.ts"

/** The modules of the plugins, in the order of `ids`. */
export const modules = [
	AuditPlugin,
	MailPlugin,
	PlatformPlugin,
	OrganizationPlugin,
	AccessPlugin,
	SsoPlugin,
	AuthPlugin,
	AuthorizationPlugin,
	ModelsPlugin,
	FilesPlugin,
	BotsPlugin,
	CapabilitiesPlugin,
	WorkPlugin,
	ImportedPlugin,
	ChatsPlugin,
	ChannelsPlugin,
	AppsPlugin,
	CodePlugin,
	VaultsPlugin,
	ComputersPlugin,
	TriggersPlugin,
	BillingPlugin,
	SettingsPlugin,
] as const

/**
 * The plugins of OpenBot by module name. The loader resolves the name of an
 * entry with this table.
 */
export const plugins: Readonly<Record<string, GraftPlugin.Plugin>> =
	Rec.fromEntries(
		Arr.map(modules, (module) => [nameOf(module.id), module.default] as const),
	)

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

/** The keys that the plugins publish, from the list of each plugin. */
export const published = [
	...AuditPlugin.publishes,
	...MailPlugin.publishes,
	...PlatformPlugin.publishes,
	...OrganizationPlugin.publishes,
	...AccessPlugin.publishes,
	...SsoPlugin.publishes,
	...AuthPlugin.publishes,
	...AuthorizationPlugin.publishes,
	...ModelsPlugin.publishes,
	...FilesPlugin.publishes,
	...BotsPlugin.publishes,
	...CapabilitiesPlugin.publishes,
	...WorkPlugin.publishes,
	...ImportedPlugin.publishes,
	...ChatsPlugin.publishes,
	...ChannelsPlugin.publishes,
	...AppsPlugin.publishes,
	...CodePlugin.publishes,
	...VaultsPlugin.publishes,
	...ComputersPlugin.publishes,
	...TriggersPlugin.publishes,
	...BillingPlugin.publishes,
	...SettingsPlugin.publishes,
] as const
