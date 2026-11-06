/**
 * What the host derives from the preset: the plugins by module name, what
 * the rules of the plugins file know, and the check of the required plugins.
 * This module is not public.
 */
import type { Plugin as GraftPlugin } from "@graftland/graft"
import { type Entry, Loader, Tree } from "@graftland/loader"
import {
	Array as Arr,
	Effect,
	Record as Rec,
	Ref,
	Result,
	Schema,
	Stream,
} from "effect"
import * as PluginsFile from "./PluginsFile.ts"
import * as Preset from "./Preset.ts"

const table = Rec.values(Preset.plugins)

/**
 * The plugins of OpenBot by module name. The loader resolves the name of an
 * entry with this table.
 */
export const plugins: Readonly<Record<string, GraftPlugin.Plugin>> =
	Rec.fromEntries(Arr.map(table, (plugin) => [plugin.name, plugin.plugin]))

/** The ids of the plugins that take config. */
const configurable = Arr.filterMap(
	Rec.toEntries(Preset.plugins),
	([id, plugin]) =>
		"configurable" in plugin ? Result.succeed(id) : Result.failVoid,
)

/**
 * What the rules of the plugins file know about the preset. A host with the
 * entries or the plugins of a test changes `base` and `bundled`.
 */
export const known: PluginsFile.Known = {
	base: Preset.entries,
	bundled: Arr.map(table, (plugin) => plugin.name),
	required: Preset.required,
	configurable,
}

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
		Preset.required,
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
