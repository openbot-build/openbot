import { Effect, Option, Path, Schema, Stream } from "effect"
import { ChildProcess } from "effect/process"

/** Finds the built entry of a declared command or development script. */
export const path = (
	entry: "server" | "migrate" | "setup" | "inspect" | "development",
) =>
	Effect.gen(function* () {
		const path = yield* Path.Path
		const file = {
			server: "Main.js",
			migrate: "Migrate.js",
			setup: "Setup.js",
			inspect: "Inspect.js",
			development: "DevelopmentMain.js",
		}[entry]
		// The development server is a program of its own package.
		const root = yield* path.fromFileUrl(
			new URL(
				entry === "development"
					? import.meta.resolve("@openbot-build/server-development/Development")
					: import.meta.resolve("@openbot-build/openbot"),
			),
		)
		return path.join(path.dirname(root), file)
	})

/** The part of the report of `openbot-inspect plugins` that a test reads. */
const PluginsReport = Schema.fromJsonString(
	Schema.Struct({ manifestHash: Schema.String }),
)

/**
 * Runs the built `openbot-inspect plugins` with this plugins file, or with
 * none, and gives the manifest hash that it prints.
 */
export const inspectPlugins = (file: Option.Option<string>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const entry = yield* path("inspect")
			const child = yield* ChildProcess.make(
				process.execPath,
				[
					entry,
					"plugins",
					...Option.match(file, {
						onNone: () => [],
						onSome: (file) => ["--file", file],
					}),
				],
				{ stdin: "ignore", stderr: "ignore" },
			)
			const text = yield* child.stdout.pipe(Stream.decodeText, Stream.mkString)
			return (yield* Schema.decodeEffect(PluginsReport)(text)).manifestHash
		}),
	)
