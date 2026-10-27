import { NodeServices } from "@effect/platform-node"
import {
	Array as Arr,
	Config,
	Context,
	Effect,
	Fiber,
	FileSystem,
	Layer,
	Path,
	Record as Rec,
	Ref,
	Schema,
	Stream,
} from "effect"
import { ChildProcess } from "effect/process"

const Package = Schema.fromJsonString(
	Schema.Struct({
		version: Schema.String,
		bin: Schema.Record(Schema.String, Schema.String),
	}),
)

export const SavedConfig = Schema.fromJsonString(
	Schema.Struct({
		url: Schema.String,
		token: Schema.String,
		machineId: Schema.String,
	}),
)

const readBin = Effect.fn("readBin")(function* (
	name: "@openbot-build/cli" | "@openbot-build/computer",
	command: string,
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const file = yield* path.fromFileUrl(
		new URL(import.meta.resolve(`${name}/package.json`)),
	)
	const manifest = yield* Schema.decodeEffect(Package)(
		yield* fs.readFileString(file),
	)
	const entry = yield* Effect.fromOption(Rec.get(manifest.bin, command))
	return {
		file: path.resolve(path.dirname(file), entry),
		version: manifest.version,
	}
})

export class Commands extends Context.Service<
	Commands,
	{
		readonly openbot: string
		readonly computer: string
		readonly computerVersion: string
	}
>()("@openbot-build/e2e/test/cli/Process/Commands") {}

export const commands = Layer.effect(
	Commands,
	Effect.gen(function* () {
		const openbot = yield* readBin("@openbot-build/cli", "openbot")
		const computer = yield* readBin(
			"@openbot-build/computer",
			"openbot-computer",
		)
		return {
			openbot: openbot.file,
			computer: computer.file,
			computerVersion: computer.version,
		}
	}),
).pipe(Layer.provideMerge(NodeServices.layer))

/** Each test gets its own paths. A space in each path also tests argument use. */
export const makeFiles = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const commands = yield* Commands
	const folder = yield* fs.makeTempDirectoryScoped({
		prefix: "openbot e2e cli ",
	})
	const bin = path.join(folder, "bin")
	const configHome = path.join(folder, "config")
	const configFile = path.join(configHome, "openbot", "computer.json")
	yield* fs.makeDirectory(bin)
	yield* fs.makeDirectory(path.dirname(configFile), { recursive: true })
	yield* fs.symlink(commands.openbot, path.join(bin, "openbot"))
	yield* fs.symlink(commands.computer, path.join(bin, "openbot-computer"))
	yield* fs.symlink(process.execPath, path.join(bin, "node"))
	return { folder, bin, configHome, configFile }
})

export type Files = Effect.Success<typeof makeFiles>

/** Start a public command with only its paths and plain terminal settings. */
export const start = Effect.fn("start")(function* (
	files: Files,
	args: ReadonlyArray<string>,
	command: "openbot" | "openbot-computer" = "openbot",
) {
	const path = yield* Path.Path
	const inherited = yield* Config.String("PATH").pipe(Config.withDefault(""))
	// Path has no PATH delimiter. Windows uses semicolons between folders.
	const delimiter = path.sep === "\\" ? ";" : ":"
	const handle = yield* ChildProcess.make(
		process.execPath,
		[path.join(files.bin, command), ...args],
		{
			cwd: files.folder,
			stdin: "ignore",
			extendEnv: false,
			env: {
				PATH: Arr.join([files.bin, inherited], delimiter),
				XDG_CONFIG_HOME: files.configHome,
				NO_COLOR: "1",
				TERM: "dumb",
			},
		},
	)
	const stdout = yield* Ref.make("")
	const stderr = yield* Ref.make("")
	const collect = <E>(
		stream: Stream.Stream<Uint8Array, E>,
		ref: Ref.Ref<string>,
	) =>
		stream.pipe(
			Stream.decodeText(),
			Stream.runForEach((part) => Ref.update(ref, (text) => text + part)),
		)
	const done = yield* Effect.forkScoped(
		Effect.gen(function* () {
			const [, , code] = yield* Effect.all(
				[
					collect(handle.stdout, stdout),
					collect(handle.stderr, stderr),
					handle.exitCode,
				],
				{ concurrency: "unbounded" },
			)
			return {
				code,
				stdout: yield* Ref.get(stdout),
				stderr: yield* Ref.get(stderr),
			}
		}),
	)
	return {
		stdout: Ref.get(stdout),
		stderr: Ref.get(stderr),
		done: Fiber.join(done),
	}
})

export const run = Effect.fn("run")(
	function* (
		files: Files,
		args: ReadonlyArray<string>,
		command: "openbot" | "openbot-computer" = "openbot",
	) {
		return yield* (yield* start(files, args, command)).done
	},
	Effect.scoped,
	Effect.timeout("15 seconds"),
)

export const readSaved = Effect.fn("readSaved")(function* (files: Files) {
	const fs = yield* FileSystem.FileSystem
	return yield* Schema.decodeEffect(SavedConfig)(
		yield* fs.readFileString(files.configFile),
	)
})
