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
		const root = yield* path.fromFileUrl(
			new URL(import.meta.resolve("@openbot-build/openbot")),
		)
		return path.join(path.dirname(root), file)
	})
