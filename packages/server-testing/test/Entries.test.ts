import { assert, layer } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import {
	Array as Arr,
	Effect,
	FileSystem,
	Path,
	Record as Rec,
	Schema,
	String as Str,
} from "effect"

const Manifest = Schema.fromJsonString(
	Schema.Struct({
		name: Schema.String,
		exports: Schema.Record(Schema.String, Schema.String),
	}),
)

// The entry of this package has values, so it is not type only.
const typeOnly: ReadonlyArray<string> = []

// Other packages use the entry by the package name, so this test reads it by
// that name. Importing it must start no I/O.
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
				assert.isTrue(Arr.isReadonlyArrayNonEmpty(keys))
				for (const key of keys) {
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
				}
			}),
	)
})
