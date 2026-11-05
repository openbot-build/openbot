import { Effect, Path } from "effect"

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
