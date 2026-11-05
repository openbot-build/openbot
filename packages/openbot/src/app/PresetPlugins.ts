/**
 * The plugins of the preset, the entries of the loader, and the check of the
 * required plugins. The host uses this module. It is not public.
 */
import type { Plugin as GraftPlugin } from "@graftland/graft"
import { type Entry, Loader, Tree } from "@graftland/loader"
import AccessPlugin from "@openbot-build/plugin-access"
import ArtifactsPlugin from "@openbot-build/plugin-artifacts"
import AppsPlugin from "@openbot-build/plugin-apps"
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
import ImportedPlugin from "@openbot-build/plugin-imported"
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
import {
	Array as Arr,
	Effect,
	Record as Rec,
	Ref,
	Schema,
	Stream,
} from "effect"
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
	models: ModelsPlugin,
	files: FilesPlugin,
	bots: BotsPlugin,
	capabilities: CapabilitiesPlugin,
	work: WorkPlugin,
	imported: ImportedPlugin,
	chats: ChatsPlugin,
	channels: ChannelsPlugin,
	apps: AppsPlugin,
	code: CodePlugin,
	vaults: VaultsPlugin,
	computers: ComputersPlugin,
	artifacts: ArtifactsPlugin,
	triggers: TriggersPlugin,
	billing: BillingPlugin,
	settings: SettingsPlugin,
	"turn-limiter": TurnLimiterPlugin,
	"time-limiter": TimeLimiterPlugin,
	"token-limiter": TokenLimiterPlugin,
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

/**
 * The keys that the plugins publish, read from each plugin. The limit plugins
 * publish nothing, so they are not here.
 */
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
	...Feature.published(byId.artifacts),
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
