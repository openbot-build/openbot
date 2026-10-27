import { NodeServices } from "@effect/platform-node"
import { assert, layer } from "@effect/vitest"
import {
	Array as Arr,
	Config,
	Context,
	Effect,
	FileSystem,
	Layer,
	Option,
	Path,
	Stream,
} from "effect"
import { ChildProcess } from "effect/process"
import * as Dispatch from "../src/Dispatch.ts"
import { signalOf } from "../src/Signal.ts"

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

/** How the openbot program ended: with an exit code, or on a signal. */
interface Ending {
	readonly status: Option.Option<number>
	readonly signal: Option.Option<string>
}

const text = <E>(stream: Stream.Stream<Uint8Array, E>) =>
	stream.pipe(Stream.decodeText(), Stream.mkString)

/** Runs the built openbot program, with the test commands first on PATH. */
const openbot = Effect.fn("openbot")(function* (
	args: ReadonlyArray<string>,
	env: Record<string, string> = {},
) {
	const { folder } = yield* Commands
	const path = yield* Path.Path
	const inherited = yield* Config.String("PATH").pipe(Config.withDefault(""))
	// The Path service has no PATH delimiter. On Windows the separator is "\",
	// and PATH puts ";" between folders. Other systems use ":".
	const delimiter = path.sep === "\\" ? ";" : ":"
	const main = path.join(import.meta.dirname, "..", "dist", "Main.js")
	const handle = yield* ChildProcess.make(process.execPath, [main, ...args], {
		env: { ...env, PATH: Arr.join([folder, inherited], delimiter) },
		extendEnv: true,
		stdin: "ignore",
	})
	const ending = handle.exitCode.pipe(
		Effect.map((code): Ending => ({
			status: Option.some(code),
			signal: Option.none(),
		})),
		Effect.catch((error) =>
			Option.match(signalOf(error), {
				onNone: () => Effect.fail(error),
				onSome: (signal) =>
					Effect.succeed<Ending>({
						status: Option.none(),
						signal: Option.some(signal),
					}),
			}),
		),
	)
	const [stdout, stderr, end] = yield* Effect.all(
		[text(handle.stdout), text(handle.stderr), ending],
		{ concurrency: "unbounded" },
	)
	return { ...end, stdout, stderr }
}, Effect.scoped)

// The tests run real programs, so they use real time.
layer(commands, { excludeTestServices: true })((it) => {
	it.effect(
		"openbot runs openbot-<name> from PATH and passes the arguments",
		() =>
			Effect.gen(function* () {
				const result = yield* openbot(["echo", "one", "two words", "--flag"])
				assert.deepStrictEqual(result.status, Option.some(0))
				assert.strictEqual(result.stdout, "[one]\n[two words]\n[--flag]\n")
			}),
	)

	it.effect("openbot exits with the exit code of the command", () =>
		Effect.gen(function* () {
			const result = yield* openbot(["echo"], { ECHO_EXIT: "7" })
			assert.deepStrictEqual(result.status, Option.some(7))
		}),
	)

	it.effect("openbot stops with the signal that stopped the command", () =>
		Effect.gen(function* () {
			const result = yield* openbot(["stop"])
			assert.deepStrictEqual(result.status, Option.none())
			assert.deepStrictEqual(result.signal, Option.some("SIGTERM"))
		}),
	)

	it.effect("openbot says when a command does not exist", () =>
		Effect.gen(function* () {
			const result = yield* openbot(["no-such-command"])
			assert.deepStrictEqual(result.status, Option.some(1))
			assert.strictEqual(result.stdout, "")
			assert.match(result.stderr, /'no-such-command' is not a command/)
		}),
	)

	it.effect("openbot does not take a path as a command name", () =>
		Effect.gen(function* () {
			const result = yield* openbot(["../echo"])
			assert.deepStrictEqual(result.status, Option.some(1))
			assert.match(result.stderr, /is not a command/)
		}),
	)

	it.effect("openbot, openbot help, and openbot --help list the commands", () =>
		Effect.forEach(
			[[], ["help"], ["--help"]],
			(args) =>
				Effect.gen(function* () {
					const result = yield* openbot(args)
					assert.deepStrictEqual(result.status, Option.some(0))
					assert.match(result.stdout, /^Usage: openbot <command>/)
					assert.match(result.stdout, /^ {2}echo$/m)
					assert.match(result.stdout, /^ {2}stop$/m)
					assert.notMatch(result.stdout, /^ {2}plain$/m)
				}),
			{ discard: true },
		),
	)

	it.effect("openbot help <name> runs the command with --help", () =>
		Effect.gen(function* () {
			const result = yield* openbot(["help", "echo"])
			assert.deepStrictEqual(result.status, Option.some(0))
			assert.strictEqual(result.stdout, "[--help]\n")
		}),
	)

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
