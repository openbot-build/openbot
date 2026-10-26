import { NodeServices } from "@effect/platform-node"
import { assert, layer } from "@effect/vitest"
import {
	ConfigProvider,
	Context,
	Effect,
	FileSystem,
	Layer,
	Option,
	Path,
	Redacted,
} from "effect"
import * as Config from "../src/Config.ts"

/** A folder for the config files of the tests. All tests in this file share it. */
class Folder extends Context.Service<Folder, string>()(
	"@openbot-build/computer/test/Config.test/Folder",
) {}

const folder = Layer.effect(
	Folder,
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		return yield* fs.makeTempDirectoryScoped({
			prefix: "openbot-computer-config-",
		})
	}),
).pipe(Layer.provideMerge(NodeServices.layer))

layer(folder)((it) => {
	it.effect("the config file is in XDG_CONFIG_HOME when it is set", () =>
		Effect.gen(function* () {
			const path = yield* Path.Path
			assert.strictEqual(
				yield* Config.pathIn(Option.some("/xdg"), "/home/me"),
				path.join("/xdg", "openbot", "computer.json"),
			)
			assert.strictEqual(
				yield* Config.pathIn(Option.some(""), "/home/me"),
				path.join("/home/me", ".config", "openbot", "computer.json"),
			)
			assert.strictEqual(
				yield* Config.pathIn(Option.none(), "/home/me"),
				path.join("/home/me", ".config", "openbot", "computer.json"),
			)
		}),
	)

	it.layer(
		ConfigProvider.layer(
			ConfigProvider.fromUnknown({ XDG_CONFIG_HOME: "/xdg" }),
		),
	)((it) => {
		it.effect("the config path comes from the environment", () =>
			Effect.gen(function* () {
				const path = yield* Path.Path
				assert.strictEqual(
					yield* Config.path,
					path.join("/xdg", "openbot", "computer.json"),
				)
			}),
		)
	})

	it.effect("a missing config file reads as none", () =>
		Effect.gen(function* () {
			const path = yield* Path.Path
			const config = yield* Config.read(path.join(yield* Folder, "none.json"))
			assert.ok(Option.isNone(config))
		}),
	)

	it.effect("the config is saved so that only the owner can read it", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const file = path.join(
				yield* Folder,
				"nested",
				"openbot",
				"computer.json",
			)
			const config = {
				url: "https://openbot.example.com",
				token: Redacted.make("secret-token"),
				machineId: yield* Config.makeMachineId,
			}
			yield* Config.write(file, config)
			assert.strictEqual((yield* fs.stat(file)).mode & 0o777, 0o600)
			const read = yield* Effect.fromOption(yield* Config.read(file))
			assert.strictEqual(read.url, config.url)
			assert.strictEqual(read.machineId, config.machineId)
			// Equality does not see the value of a Redacted, so check the token itself.
			assert.strictEqual(Redacted.value(read.token), "secret-token")

			// Writing again keeps the mode.
			yield* Config.write(file, {
				...config,
				token: Redacted.make("new-token"),
			})
			assert.strictEqual((yield* fs.stat(file)).mode & 0o777, 0o600)
			assert.deepStrictEqual(
				Option.map(yield* Config.read(file), (saved) =>
					Redacted.value(saved.token),
				),
				Option.some("new-token"),
			)
			// The file holds the token as plain text, not as "<redacted>".
			assert.include(yield* fs.readFileString(file), '"new-token"')
			assert.deepStrictEqual(yield* fs.readDirectory(path.dirname(file)), [
				"computer.json",
			])
		}),
	)

	it.effect("a failed write leaves no file with the token behind", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const folder = path.join(yield* Folder, "blocked")
			// A folder in the place of the file makes the last move fail.
			const file = path.join(folder, "computer.json")
			yield* fs.makeDirectory(path.join(file, "inside"), { recursive: true })
			const error = yield* Effect.flip(
				Config.write(file, {
					url: "https://openbot.example.com",
					token: Redacted.make("secret-token"),
					machineId: yield* Config.makeMachineId,
				}),
			)
			assert.match(error.message, /Could not write/)
			assert.deepStrictEqual(yield* fs.readDirectory(folder), ["computer.json"])
		}),
	)

	it.effect("a broken config file gives a clear error", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const file = path.join(yield* Folder, "broken.json")
			yield* fs.writeFileString(file, "{ not json")
			const error = yield* Effect.flip(Config.read(file))
			assert.match(error.message, /is not a valid config/)
		}),
	)

	it.effect("a machine ID is long and random", () =>
		Effect.gen(function* () {
			const first = yield* Config.makeMachineId
			assert.ok(first.length >= 16)
			assert.notStrictEqual(first, yield* Config.makeMachineId)
		}),
	)

	it.effect("an OpenBot address must be an http or https origin", () =>
		Effect.gen(function* () {
			assert.strictEqual(
				yield* Config.parseOrigin("https://openbot.example.com/path"),
				"https://openbot.example.com",
			)
			const error = yield* Effect.flip(Config.parseOrigin("ftp://example.com"))
			assert.match(error.message, /is not an OpenBot address/)
		}),
	)
})
