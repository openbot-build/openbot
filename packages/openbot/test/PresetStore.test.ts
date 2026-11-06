import { assert, it } from "@effect/vitest"
import { Loader, Tree } from "@graftland/loader"
import {
	Array as Arr,
	Effect,
	Exit,
	Option,
	Record as Rec,
	Result,
	Schema,
	Stream,
} from "effect"
import * as PluginsFile from "../src/PluginsFile.ts"
import * as Preset from "../src/Preset.ts"
import * as PresetPlugins from "../src/PresetPlugins.ts"

const all = Preset.entries

it.effect("the check names each required plugin that is missing", () =>
	Effect.gen(function* () {
		const exit = yield* Effect.exit(
			PresetPlugins.check(
				Arr.filter(all, (entry) => entry.id !== "auth" && entry.id !== "audit"),
			),
		)
		assert.deepStrictEqual(
			exit,
			Exit.fail(
				PresetPlugins.RequiredPluginMissing.make({ ids: ["audit", "auth"] }),
			),
		)
		assert.deepStrictEqual(
			yield* Effect.exit(PresetPlugins.check(all)),
			Exit.void,
		)
	}),
)

it.effect("a turned off required plugin counts as missing", () =>
	Effect.gen(function* () {
		const entries = Arr.map(all, (entry) =>
			entry.id === "platform" ? { ...entry, disabled: true } : entry,
		)
		const exit = yield* Effect.exit(PresetPlugins.check(entries))
		assert.deepStrictEqual(
			exit,
			Exit.fail(
				PresetPlugins.RequiredPluginMissing.make({ ids: ["platform"] }),
			),
		)
	}),
)

it.effect("the store refuses an edit that turns off a required plugin", () =>
	Effect.gen(function* () {
		const store = yield* PresetPlugins.store(all, PresetPlugins.known)
		const refused = yield* Effect.exit(
			store.apply(Tree.Op.Update({ id: "auth", patch: { disabled: true } })),
		)
		assert.deepStrictEqual(
			refused,
			Exit.fail(
				Loader.StoreError.make({
					cause: PresetPlugins.RequiredPluginMissing.make({ ids: ["auth"] }),
				}),
			),
		)
		// Other plugins can still be turned off.
		const next = yield* store.apply(
			Tree.Op.Update({ id: "triggers", patch: { disabled: true } }),
		)
		assert.isTrue(
			Arr.some(
				next,
				(entry) => entry.id === "triggers" && entry.disabled === true,
			),
		)
	}),
)

/** The reasons of a refused edit, whose cause must be `EntriesInvalid`. */
const refusedWith = <A>(refused: Effect.Effect<A, Loader.EditError>) =>
	Effect.map(Effect.flip(refused), (error) =>
		error._tag === "StoreError" &&
		Schema.is(PluginsFile.EntriesInvalid)(error.cause)
			? Arr.map(error.cause.problems, (problem) => problem.reason)
			: assert.fail("The edit was not refused with EntriesInvalid."),
	)

it.effect("the store refuses an edit that breaks a rule of the entries", () =>
	Effect.gen(function* () {
		const store = yield* PresetPlugins.store(all, PresetPlugins.known)
		assert.deepStrictEqual(
			yield* refusedWith(
				store.apply(
					Tree.Op.Update({
						id: "auth",
						patch: { name: Preset.plugins["triggers"].name },
					}),
				),
			),
			["The name of a preset plugin can not change."],
		)
		assert.deepStrictEqual(
			yield* refusedWith(
				store.apply(
					Tree.Op.Update({ id: "bots", patch: { group: true, config: [] } }),
				),
			),
			[
				'The field "group" is not allowed here.',
				"This plugin takes no config.",
			],
		)
		assert.deepStrictEqual(
			yield* refusedWith(
				store.apply(
					Tree.Op.Create({
						entry: { id: "outside", name: "outside-plugin" },
						parent: Option.none(),
						position: Option.none(),
					}),
				),
			),
			[
				"There is no plugin with this name in OpenBot. Only plugins that come with OpenBot can run.",
			],
		)
		// A refused edit changes nothing.
		const next = yield* store.apply(
			Tree.Op.Update({ id: "bots", patch: { disabled: true } }),
		)
		assert.deepStrictEqual(
			Arr.map(next, (entry) => entry.id),
			Arr.map(all, (entry) => entry.id),
		)
	}),
)

it.live("the store of a plugins file never reads it again", () =>
	Effect.gen(function* () {
		const entries = Result.getOrThrow(
			Result.flatMap(
				PluginsFile.parse("- id: triggers\n  disabled: true\n"),
				(raw) => PluginsFile.merge(PresetPlugins.known, raw),
			),
		)
		const store = yield* PresetPlugins.store(entries, PresetPlugins.known)
		assert.deepStrictEqual(store.initial, entries)
		assert.deepStrictEqual(yield* store.refresh, Option.none())
		const outside = yield* Stream.runHead(store.external).pipe(
			Effect.timeoutOption("100 millis"),
		)
		assert.deepStrictEqual(outside, Option.none())
		const refused = yield* Effect.exit(
			store.apply(Tree.Op.Update({ id: "auth", patch: { disabled: true } })),
		)
		assert.deepStrictEqual(
			refused,
			Exit.fail(
				Loader.StoreError.make({
					cause: PresetPlugins.RequiredPluginMissing.make({ ids: ["auth"] }),
				}),
			),
		)
	}),
)

it("the preset derives its entries and its required plugins from one table", () => {
	assert.deepStrictEqual(
		Arr.map(Preset.entries, (entry) => entry.id),
		Rec.keys(Preset.plugins),
	)
	assert.deepStrictEqual(
		Arr.map(Preset.entries, (entry) => entry.name),
		Arr.map(Rec.values(Preset.plugins), (plugin) => plugin.name),
	)
	// The loader finds a plugin by the module name of its entry.
	assert.isTrue(
		Arr.every(Preset.entries, (entry) =>
			Rec.has(PresetPlugins.plugins, entry.name),
		),
	)
	assert.deepStrictEqual(Preset.required, [
		"audit",
		"platform",
		"organization",
		"access",
		"auth",
		"authorization",
	])
})
