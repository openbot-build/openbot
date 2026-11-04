import { assert, it } from "@effect/vitest"
import { Loader, Tree } from "@graftland/loader"
import { Array as Arr, Effect, Exit } from "effect"
import * as Preset from "../src/app/Preset.ts"
import * as PresetPlugins from "../src/app/PresetPlugins.ts"

const all = Arr.map(Preset.ids, (id) => ({ id, name: Preset.nameOf(id) }))

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
				PresetPlugins.RequiredPluginMissing.make({ ids: ["auth", "audit"] }),
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
		const store = yield* PresetPlugins.store(all)
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
