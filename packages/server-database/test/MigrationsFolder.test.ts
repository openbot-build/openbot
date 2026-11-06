import { NodeServices } from "@effect/platform-node"
import { assert, layer } from "@effect/vitest"
import { Array as Arr, Effect, FileSystem, Order, Path } from "effect"
import { migrationsFolder } from "../src/MigrationsFolder.ts"

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
	it.effect("the migrations folder is the folder of the package", () =>
		Effect.gen(function* () {
			const path = yield* Path.Path
			const expected = yield* path.fromFileUrl(
				new URL("../migrations", import.meta.url),
			)
			assert.strictEqual(migrationsFolder, expected)
		}),
	)

	it.effect("every migration has its SQL and its snapshot", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const names = yield* fs.readDirectory(migrationsFolder)
			assert.isTrue(Arr.contains(names, "20261021185430_baseline"))
			yield* Effect.forEach(
				names,
				(name) =>
					Effect.gen(function* () {
						const files = yield* fs.readDirectory(
							path.join(migrationsFolder, name),
						)
						assert.deepStrictEqual(Arr.sort(files, Order.String), [
							"migration.sql",
							"snapshot.json",
						])
					}),
				{ discard: true },
			)
		}),
	)
})
