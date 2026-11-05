import { assert, layer } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import {
	Array as Arr,
	Effect,
	FileSystem,
	Path,
	Predicate,
	Record as Rec,
	Schema,
	String as Str,
} from "effect"

const Dependencies = Schema.optional(
	Schema.Record(Schema.String, Schema.String),
)

const Manifest = Schema.fromJsonString(
	Schema.Struct({
		name: Schema.String,
		exports: Schema.Record(Schema.String, Schema.String),
		dependencies: Dependencies,
		devDependencies: Dependencies,
		peerDependencies: Dependencies,
	}),
)

// Every entry of this package has a value, so none is type only.
const typeOnly: ReadonlyArray<string> = []

// The built entries are what other packages use, so this test reads them by
// the package name and not from the source.
layer(NodeServices.layer)((it) => {
	it.effect(
		"every entry of the package loads and has only its own exports",
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const path = yield* Path.Path
				const file = yield* path.fromFileUrl(
					new URL("../package.json", import.meta.url),
				)
				const manifest = yield* Schema.decodeEffect(Manifest)(
					yield* fs.readFileString(file),
				)
				const keys = Rec.keys(manifest.exports)
				assert.isTrue(Arr.contains(keys, "."))
				for (const key of keys) {
					// Each key is the built file of the source module with the same name.
					assert.strictEqual(
						manifest.exports[key],
						key === "." ? "./dist/index.js" : `./dist/${Str.slice(2)(key)}.js`,
						key,
					)
					const name = `${manifest.name}${Str.slice(1)(key)}`
					const entry: Readonly<Record<string, unknown>> =
						yield* Effect.promise(() => import(/* @vite-ignore */ name))
					const names = Rec.keys(entry)
					assert.strictEqual(
						names.length > 0,
						!Arr.contains(typeOnly, key),
						name,
					)
					assert.deepStrictEqual(
						Arr.filter(names, Str.endsWith("_exports")),
						[],
						name,
					)
					if (key !== ".") continue
					// The plugin is the only export. The loader finds it by the package name.
					assert.deepStrictEqual(names, ["default"], name)
					const plugin = entry["default"]
					assert.isTrue(
						Predicate.hasProperty(plugin, "apply") &&
							Predicate.hasProperty(plugin, "inject"),
						name,
					)
					assert.strictEqual(
						Predicate.hasProperty(plugin, "name") ? plugin.name : undefined,
						manifest.name,
					)
				}
				// A plugin does not use another plugin. The host connects them.
				const named = Arr.flatMap(
					[
						manifest.dependencies,
						manifest.devDependencies,
						manifest.peerDependencies,
					],
					(list) => (list === undefined ? [] : Rec.keys(list)),
				)
				assert.deepStrictEqual(
					Arr.filter(named, Str.startsWith("@openbot-build/plugin-")),
					[],
				)
			}),
	)
})
