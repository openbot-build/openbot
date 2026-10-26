import {
	Array as Arr,
	Effect,
	FileSystem,
	Option,
	Order,
	Path,
	pipe,
	String as Str,
} from "effect"

/** Every command is a program named `openbot-<name>`. */
export const prefix = "openbot-"

/** A command name has only small letters, digits, and dashes, so it can never be a path. */
const validName = /^[a-z0-9][a-z0-9-]*$/

export const isValidName = (name: string): boolean => validName.test(name)

/**
 * The folders where `openbot` looks for commands, in order:
 * 1. The folder of its own real file, and the folder of the link that started it.
 * 2. Each `node_modules/.bin` above its own real file, from the nearest one up.
 * 3. Each folder on PATH.
 */
export const searchFolders = Effect.fn("Dispatch.searchFolders")(
	function* (options: {
		/** The path that started this program, such as `process.argv[1]`. */
		readonly script: string
		/** The PATH variable. */
		readonly path: string
	}) {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const realScript = yield* fs
			.realPath(options.script)
			.pipe(Effect.orElseSucceed(() => options.script))
		const real = path.dirname(realScript)
		const binFolder = (folder: string) =>
			path.basename(folder) === "node_modules"
				? path.join(folder, ".bin")
				: path.join(folder, "node_modules", ".bin")
		const above = Arr.unfold(Option.some(real), (current) =>
			Option.map(current, (folder) => [
				binFolder(folder),
				path.dirname(folder) === folder
					? Option.none()
					: Option.some(path.dirname(folder)),
			]),
		)
		// The Path service has no PATH delimiter. On Windows the separator is "\",
		// and PATH puts ";" between folders. Other systems use ":".
		const delimiter = path.sep === "\\" ? ";" : ":"
		const onPath = pipe(
			options.path,
			Str.split(delimiter),
			Arr.filter(Str.isNonEmpty),
		)
		return Arr.dedupe([real, path.dirname(options.script), ...above, ...onPath])
	},
)

/**
 * A command is a file with a right to run. The FileSystem service has no check for
 * the right to run (X_OK), so this looks at the run bits of the file mode.
 */
const isExecutable = (file: string) =>
	Effect.flatMap(FileSystem.FileSystem, (fs) => fs.stat(file)).pipe(
		Effect.map((info) => info.type === "File" && (info.mode & 0o111) !== 0),
		Effect.orElseSucceed(() => false),
	)

/** The first executable `openbot-<name>` in the folders. */
export const find = Effect.fn("Dispatch.find")(function* (
	name: string,
	folders: ReadonlyArray<string>,
) {
	if (!isValidName(name)) return Option.none<string>()
	const path = yield* Path.Path
	const files = Arr.map(folders, (folder) => path.join(folder, prefix + name))
	return yield* Effect.findFirst(files, isExecutable)
})

/** The names of all commands in the folders, sorted, each name once. */
export const list = Effect.fn("Dispatch.list")(function* (
	folders: ReadonlyArray<string>,
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const nameOf = Str.slice(prefix.length)
	const inFolder = (folder: string) =>
		fs.readDirectory(folder).pipe(
			Effect.orElseSucceed((): ReadonlyArray<string> => []),
			Effect.flatMap((entries) =>
				Effect.filter(
					Arr.filter(
						entries,
						(entry) =>
							Str.startsWith(prefix)(entry) && isValidName(nameOf(entry)),
					),
					(entry) => isExecutable(path.join(folder, entry)),
				),
			),
			Effect.map(Arr.map(nameOf)),
		)
	const names = yield* Effect.forEach(folders, inFolder)
	return pipe(names, Arr.flatten, Arr.dedupe, Arr.sort(Order.String))
})

export const usage = (names: ReadonlyArray<string>): string =>
	Arr.join(
		[
			"Usage: openbot <command> [arguments]",
			"",
			"Run 'openbot <command> --help' to see the help of a command.",
			"",
			names.length === 0
				? "There are no commands."
				: Arr.join(
						["Commands:", ...Arr.map(names, (name) => `  ${name}`)],
						"\n",
					),
		],
		"\n",
	)

export const unknown = (name: string): string =>
	`openbot: '${name}' is not a command. Run 'openbot help' to see the commands.`
