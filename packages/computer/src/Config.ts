// These functions take all their inputs at once. A pipeable form does not help here.
// @effect-diagnostics missingPipeableSignature:off
import { randomBytes } from "node:crypto"
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { Data, Effect, Option, Schema } from "effect"

/** A failure that the person can read and act on. */
export class ComputerError extends Data.TaggedError("ComputerError")<{
	readonly message: string
}> {}

/** Makes an origin from what the person typed, or fails with a clear message. */
export const parseOrigin = (
	value: string,
): Effect.Effect<string, ComputerError> =>
	Effect.suspend(() => {
		const url = URL.canParse(value) ? new URL(value) : undefined
		return url !== undefined &&
			(url.protocol === "https:" || url.protocol === "http:") &&
			url.username === "" &&
			url.password === ""
			? Effect.succeed(url.origin)
			: Effect.fail(
					new ComputerError({
						message: `'${value}' is not an OpenBot address. Use an address such as https://openbot.example.com.`,
					}),
				)
	})

/** What `openbot computer pair` saves. The token is a secret, so only the owner can read the file. */
export const ComputerConfig = Schema.Struct({
	url: Schema.String,
	token: Schema.String,
	machineId: Schema.String,
})
export type ComputerConfig = typeof ComputerConfig.Type

const ConfigJson = Schema.fromJsonString(ComputerConfig)

/** `$XDG_CONFIG_HOME/openbot/computer.json`, or `~/.config/openbot/computer.json`. */
export const path = (
	env: Readonly<Record<string, string | undefined>> = process.env,
): string => {
	const base = env["XDG_CONFIG_HOME"]
	return join(
		base !== undefined && base !== "" ? base : join(homedir(), ".config"),
		"openbot",
		"computer.json",
	)
}

/** The saved config, or none when the file does not exist. */
export const read = (
	file: string,
): Effect.Effect<Option.Option<ComputerConfig>, ComputerError> =>
	Effect.tryPromise({
		try: () =>
			readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return undefined
				throw error
			}),
		catch: (error) =>
			new ComputerError({
				message: `Could not read ${file}: ${String(error)}`,
			}),
	}).pipe(
		Effect.flatMap((text) =>
			text === undefined
				? Effect.succeedNone
				: Schema.decodeEffect(ConfigJson)(text).pipe(
						Effect.asSome,
						Effect.mapError(
							() =>
								new ComputerError({
									message: `${file} is not a valid config. Run 'openbot computer pair' again.`,
								}),
						),
					),
		),
	)

/**
 * Saves the config so that only the owner can read and write it (mode 0600).
 * It writes a new file first and then moves it over the old one, so a crash never leaves half a file.
 */
export const write = (
	file: string,
	config: ComputerConfig,
): Effect.Effect<void, ComputerError> =>
	Effect.tryPromise({
		try: async () => {
			await mkdir(dirname(file), { recursive: true, mode: 0o700 })
			const next = `${file}.${process.pid}.tmp`
			await writeFile(next, `${JSON.stringify(config, null, "\t")}\n`, {
				mode: 0o600,
			})
			// The mode of writeFile is changed by the umask, so set it again.
			await chmod(next, 0o600)
			await rename(next, file)
		},
		catch: (error) =>
			new ComputerError({
				message: `Could not write ${file}: ${String(error)}`,
			}),
	})

/** A new random machine ID: 32 hex characters. */
export const makeMachineId = (): string => randomBytes(16).toString("hex")
