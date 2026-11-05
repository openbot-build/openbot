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

// `./bots/BotMemories` has only types, so it has no export at run time.
const typeOnly: ReadonlyArray<string> = ["./bots/BotMemories"]

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
