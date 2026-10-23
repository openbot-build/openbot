// These functions take all their inputs at once. A pipeable form does not help here.
// @effect-diagnostics missingPipeableSignature:off
import {
	accessSync,
	constants,
	readdirSync,
	realpathSync,
	statSync,
} from "node:fs"
import { delimiter, dirname, join, parse } from "node:path"

/** Every command is a program named `openbot-<name>`. */
export const prefix = "openbot-"

/** A command name has only small letters, digits, and dashes, so it can never be a path. */
const validName = /^[a-z0-9][a-z0-9-]*$/

export const isValidName = (name: string): boolean => validName.test(name)

const realPath = (path: string): string => {
	try {
		return realpathSync(path)
	} catch {
		return path
	}
}

/**
 * The folders where `openbot` looks for commands, in order:
 * 1. The folder of its own real file, and the folder of the link that started it.
 * 2. Each `node_modules/.bin` above its own real file, from the nearest one up.
 * 3. Each folder on PATH.
 */
export const searchFolders = (options: {
	/** The path that started this program, such as `process.argv[1]`. */
	readonly script: string
	/** The PATH variable. */
	readonly path: string | undefined
}): ReadonlyArray<string> => {
	const real = dirname(realPath(options.script))
	const near = [real, dirname(options.script)]
	const above: Array<string> = []
	for (let folder = real; ; folder = dirname(folder)) {
		above.push(
			parse(folder).base === "node_modules"
				? join(folder, ".bin")
				: join(folder, "node_modules", ".bin"),
		)
		if (dirname(folder) === folder) break
	}
	const onPath = (options.path ?? "")
		.split(delimiter)
		.filter((part) => part !== "")
	return [...new Set([...near, ...above, ...onPath])]
}

const isExecutable = (file: string): boolean => {
	try {
		if (!statSync(file).isFile()) return false
		accessSync(file, constants.X_OK)
		return true
	} catch {
		return false
	}
}

/** The first executable `openbot-<name>` in the folders, or `undefined`. */
export const find = (
	name: string,
	folders: ReadonlyArray<string>,
): string | undefined => {
	if (!isValidName(name)) return undefined
	for (const folder of folders) {
		const file = join(folder, prefix + name)
		if (isExecutable(file)) return file
	}
	return undefined
}

/** The names of all commands in the folders, sorted, each name once. */
export const list = (folders: ReadonlyArray<string>): ReadonlyArray<string> => {
	const names = new Set<string>()
	for (const folder of folders) {
		let entries: ReadonlyArray<string>
		try {
			entries = readdirSync(folder)
		} catch {
			continue
		}
		for (const entry of entries) {
			if (!entry.startsWith(prefix)) continue
			const name = entry.slice(prefix.length)
			if (isValidName(name) && isExecutable(join(folder, entry)))
				names.add(name)
		}
	}
	return [...names].sort()
}

export const usage = (names: ReadonlyArray<string>): string =>
	[
		"Usage: openbot <command> [arguments]",
		"",
		"openbot runs the program openbot-<command> and gives it the arguments.",
		"It looks for the program next to itself, then in node_modules/.bin, then on PATH.",
		"Run 'openbot help <command>' to see the help of a command.",
		"",
		names.length === 0
			? "openbot found no commands."
			: ["Commands:", ...names.map((name) => `  ${name}`)].join("\n"),
		"",
	].join("\n")

export const unknown = (name: string): string =>
	`openbot: '${name}' is not a command. Run 'openbot help' to see the commands.\n`
