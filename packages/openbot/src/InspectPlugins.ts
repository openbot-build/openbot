/**
 * The report of `openbot-inspect plugins`: the plugin entries after the
 * plugins file, their config with secrets redacted, and the manifest hash.
 * It needs no database and no cluster secret, and starts no server.
 */
import type { Entry } from "@graftland/loader"
import { Array as Arr, Effect, type FileSystem, Option } from "effect"
import type { Digest } from "effect/crypto"
import * as PluginsFile from "./PluginsFile.ts"
import * as PresetPlugins from "./PresetPlugins.ts"

/** One entry of the report. */
export interface ReportEntry extends PluginsFile.Shown {
	/** `preset` for an entry of the preset, `file` for a new entry of the file. */
	readonly source: "preset" | "file"
	/** What the file changed in an entry of the preset. */
	readonly changed: ReadonlyArray<"disabled" | "config">
}

export interface Report {
	/** The path of the plugins file, or null without one. */
	readonly file: string | null
	/** The same hash that a server with this file writes. */
	readonly manifestHash: string
	readonly entries: ReadonlyArray<ReportEntry>
}

const changed = (
	entry: Entry.Entry,
	base: Option.Option<Entry.Entry>,
): ReadonlyArray<"disabled" | "config"> =>
	Option.match(base, {
		onNone: () => [],
		onSome: (base) => [
			...((entry.disabled === true) !== (base.disabled === true)
				? ["disabled" as const]
				: []),
			...(PluginsFile.canonical(entry.config) ===
			PluginsFile.canonical(base.config)
				? []
				: ["config" as const]),
		],
	})

/** The report of the preset, changed by the file when there is one. */
export const report = (
	file: Option.Option<string>,
): Effect.Effect<
	Report,
	PluginsFile.LoadError,
	FileSystem.FileSystem | Digest.Digest
> =>
	Effect.gen(function* () {
		const known = PresetPlugins.known
		const entries = Option.isSome(file)
			? yield* PluginsFile.load(file.value, known)
			: known.base
		const shown = PluginsFile.show(entries)
		return {
			file: Option.getOrNull(file),
			manifestHash: yield* PluginsFile.manifestHash(entries),
			entries: Arr.map(Arr.zip(entries, shown), ([entry, shown]) => {
				const base = Arr.findFirst(known.base, (base) => base.id === entry.id)
				return {
					...shown,
					source: Option.isSome(base) ? "preset" : "file",
					changed: changed(entry, base),
				}
			}),
		}
	})

/** The report as JSON text. */
export const render = (report: Report) => JSON.stringify(report, null, 2)
