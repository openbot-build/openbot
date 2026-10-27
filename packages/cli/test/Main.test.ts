import { NodeServices } from "@effect/platform-node"
import { assert, layer } from "@effect/vitest"
import {
	Array as Arr,
	Context,
	Effect,
	FileSystem,
	Layer,
	Option,
	Path,
} from "effect"
import * as Dispatch from "../src/Dispatch.ts"

/** The folder with the test commands. The tests put it first on PATH. */
class Commands extends Context.Service<Commands, { readonly folder: string }>()(
	"@openbot-build/cli/test/Main.test/Commands",
) {}

/** Writes a shell script that has the right to run. */
const script = Effect.fn("script")(function* (
	folder: string,
	name: string,
	body: string,
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const file = path.join(folder, name)
	yield* fs.writeFileString(file, `#!/bin/sh\n${body}\n`)
	yield* fs.chmod(file, 0o755)
	return file
})

const commands = Layer.effect(
	Commands,
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const folder = yield* fs.makeTempDirectoryScoped({
			prefix: "openbot-cli-",
		})
		yield* script(
			folder,
			"openbot-echo",
			'for arg in "$@"; do echo "[$arg]"; done\nexit "${ECHO_EXIT:-0}"',
		)
		yield* script(folder, "openbot-stop", "kill -TERM $$")
		// A file without the right to run is not a command.
		yield* fs.writeFileString(path.join(folder, "openbot-plain"), "#!/bin/sh\n")
		return { folder }
	}),
).pipe(Layer.provideMerge(NodeServices.layer))

layer(commands, { excludeTestServices: true })((it) => {
	it.effect("openbot looks next to itself before PATH", () =>
		Effect.gen(function* () {
			const { folder } = yield* Commands
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const near = yield* fs.makeTempDirectoryScoped({
				prefix: "openbot-cli-near-",
			})
			const file = yield* script(near, "openbot-echo", "")
			const folders = yield* Dispatch.searchFolders({
				script: path.join(near, "Main.js"),
				path: folder,
			})
			assert.deepStrictEqual(Arr.head(folders), Option.some(near))
			assert.deepStrictEqual(Arr.last(folders), Option.some(folder))
			assert.ok(Arr.contains(folders, path.join(near, "node_modules", ".bin")))
			assert.deepStrictEqual(
				yield* Dispatch.find("echo", folders),
				Option.some(file),
			)
		}),
	)
})
