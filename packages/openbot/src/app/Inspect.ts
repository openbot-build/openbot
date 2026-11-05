import { NodeCrypto, NodeRuntime, NodeServices } from "@effect/platform-node"
import { Config, Console, Effect, Layer, Option } from "effect"
import { Command, Flag } from "effect/cli"
import * as Administration from "../plugin-platform/Administration.ts"
import * as EnvironmentConfiguration from "@openbot-build/server-kernel/configuration/EnvironmentConfiguration"
import * as SecretFiles from "@openbot-build/server-kernel/configuration/SecretFiles"
import * as InspectPlugins from "./InspectPlugins.ts"
import * as Shared from "./Shared.ts"

const services = Layer.unwrap(
	Effect.map(EnvironmentConfiguration.load, Shared.layer),
).pipe(Layer.provide(SecretFiles.layer()))

/** Says why the plugins file could not be used, and makes the exit code 1. */
const refuse = (error: { readonly message: string }) =>
	Console.error(error.message).pipe(
		Effect.andThen(Effect.sync(() => (process.exitCode = 1))),
	)

const plugins = Command.make("plugins", {
	file: Flag.String("file").pipe(
		Flag.optional,
		Flag.withDescription(
			"The plugins file to read. The default is OPENBOT_PLUGINS_FILE.",
		),
	),
}).pipe(
	Command.withDescription(
		"Print the plugin entries after the plugins file, their config with secrets redacted, and the manifest hash, as JSON. It needs no database and no cluster secret, and starts no server. It does not read the values of !env.",
	),
	Command.withHandler(({ file }) =>
		Effect.gen(function* () {
			const path = Option.isSome(file)
				? file
				: yield* Config.option(Config.NonEmptyString("OPENBOT_PLUGINS_FILE"))
			yield* InspectPlugins.report(path).pipe(
				Effect.flatMap((report) => Console.log(InspectPlugins.render(report))),
				Effect.catchTags({
					PluginsFileInvalid: refuse,
					PluginsFileUnreadable: refuse,
				}),
			)
		}).pipe(
			// @effect-diagnostics-next-line strictEffectProvide:off -- This command reads its own settings from the environment and from secret files.
			Effect.provide(SecretFiles.layer()),
		),
	),
)

const program = Command.make("openbot inspect").pipe(
	Command.withDescription(
		"Print the platform settings and admin state as JSON. Secret values are not included.",
	),
	Command.withHandler(() =>
		Administration.inspect.pipe(
			Effect.flatMap((snapshot) => Console.log(JSON.stringify(snapshot))),
			// @effect-diagnostics-next-line strictEffectProvide:off -- This command owns its application Layer scope.
			Effect.provide(services),
		),
	),
	Command.withSubcommands([plugins]),
)
NodeRuntime.runMain(
	Command.run(program, { version: "0.1.0" }).pipe(
		// @effect-diagnostics-next-line strictEffectProvide:off -- This command owns its platform Layer scope.
		Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
	),
)
