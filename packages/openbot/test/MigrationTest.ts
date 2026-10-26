import { Array as Arr, Effect, FileSystem, Path, type Predicate } from "effect"

/** The folder with every migration of OpenBot. */
export const folder = Effect.gen(function* () {
	const path = yield* Path.Path
	return yield* path.fromFileUrl(new URL("../migrations", import.meta.url))
})

/** Copies the migrations with the names that `keep` takes into a new folder. The folder goes away at the end of the test. */
export const migrationsWhere = Effect.fn("MigrationTest.migrationsWhere")(
	function* (keep: Predicate.Predicate<string>) {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const migrations = yield* folder
		const copy = yield* fs.makeTempDirectoryScoped({
			prefix: "openbot-migrations-",
		})
		const names = yield* fs.readDirectory(migrations)
		yield* Effect.forEach(
			Arr.filter(names, keep),
			(name) => fs.copy(path.join(migrations, name), path.join(copy, name)),
			{ discard: true },
		)
		return copy
	},
)
