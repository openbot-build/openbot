import { NodeCrypto, NodeRuntime, NodeServices } from "@effect/platform-node"
import {
	Array as Arr,
	type Config,
	Effect,
	type FileSystem,
	Layer,
	type Path,
	Schema,
} from "effect"
import type { Digest, SecureRandom } from "effect/crypto"
import { Command } from "effect/cli"
import { FetchHttpClient, type HttpClient } from "effect/http"
import type * as Configuration from "@openbot-build/server-kernel/Configuration"
import * as EnvironmentConfiguration from "@openbot-build/server-kernel/EnvironmentConfiguration"
import * as SecretFiles from "@openbot-build/server-kernel/SecretFiles"
import * as OutboundGuard from "@openbot-build/server-kernel/OutboundGuard"
import * as ErrorReporting from "@openbot-build/server-kernel/Reporting"

/**
 * The platform services that a server of `server` and `main` can use: the Node
 * services, secure random values, digests, and the HTTP client.
 */
export type Platform =
	| NodeServices.NodeServices
	| SecureRandom.SecureRandom
	| Digest.Digest
	| HttpClient.HttpClient

/**
 * The host did not start: a required plugin is off, a plugin did not become
 * active, or the plugins file cannot be read or is not valid. `message` says
 * why, and `cause` holds the error of the host, such as the problems of the
 * plugins file or the forks that are not active.
 */
export class StartFailed extends Schema.TaggedError<
	StartFailed,
	{ readonly brand: unique symbol }
>()("StartFailed", {
	reason: Schema.Literals([
		"RequiredPluginMissing",
		"PluginsInactive",
		"PluginsFileInvalid",
		"PluginsFileUnreadable",
	]),
	message: Schema.String,
	cause: Schema.Defect(),
}) {}

/**
 * The settings of one server: the database, the secret keys, the cluster
 * secret and host, the address to listen on, the private addresses that
 * OpenBot may connect to, and the plugins file.
 */
export interface Settings extends Configuration.Settings {}

/**
 * Reads the settings of a server from the environment variables that
 * `openbot-server --help` names. A variable can also come from the file
 * `/run/secrets/<NAME>`. It needs the Node services.
 */
export const settings: Effect.Effect<
	Settings,
	Config.ConfigError,
	FileSystem.FileSystem | Path.Path
> = EnvironmentConfiguration.load.pipe(
	// @effect-diagnostics-next-line strictEffectProvide:off -- The secret files count only while the settings are read.
	Effect.provide(SecretFiles.layer()),
)

/**
 * Runs a server as the `openbot-server` program does. It reads the settings from
 * the environment and from secret files, blocks outbound connections to private
 * addresses, and logs a failed start. `make` gives the server, such as
 * `Host.layer`. It runs until the process stops. It gives the server the
 * fetch HTTP client, and needs the Node services (`NodeServices.layer` and
 * `NodeCrypto.layer`).
 */
export const server = <ROut, E>(
	make: (settings: Settings) => Layer.Layer<ROut, E, Platform>,
) =>
	ErrorReporting.withStartup(
		Effect.gen(function* () {
			const settings = yield* EnvironmentConfiguration.load
			return yield* Layer.launch(
				make(settings).pipe(
					Layer.provide(FetchHttpClient.layer),
					Layer.provide(OutboundGuard.layer(settings.outboundAllow)),
				),
			)
		}),
	).pipe(
		// @effect-diagnostics-next-line strictEffectProvide:off -- This program owns the whole application Layer scope.
		Effect.provide(SecretFiles.layer()),
	)

/**
 * Runs `server` as the main program of the process. It reads the command line
 * first, so `--help` and `--version` work without any settings. It gives the
 * command line and the server one set of Node services.
 */
export const main = <ROut, E>(
	make: (settings: Settings) => Layer.Layer<ROut, E, Platform>,
) =>
	NodeRuntime.runMain(
		Command.run(
			Command.make("openbot server").pipe(
				Command.withDescription(
					Arr.join(
						[
							"Run the OpenBot HTTP server.",
							"It takes its settings from these environment variables:",
							"  OPENBOT_CLUSTER_SECRET  The shared secret for private RPC. Needed.",
							"  OPENBOT_CLUSTER_HOST    The address that other nodes can reach.",
							"  OPENBOT_DATABASE_URL    The address of the Postgres database. Needed.",
							"  OPENBOT_SECRET_KEYS     The keys that keep stored secrets safe. Needed.",
							"  OPENBOT_HOST            The address to listen on. The default is 127.0.0.1.",
							"  OPENBOT_PORT            The port to listen on. The default is 3000.",
							"  OPENBOT_OUTBOUND_ALLOW  The private addresses that OpenBot may connect to.",
							"  OPENBOT_PLUGINS_FILE    A YAML file that turns plugins off. It is read one time, at start.",
							"A variable can also come from the file /run/secrets/<NAME>.",
						],
						// Effect CLI indents only the first line of a description, so the other lines get the indent here.
						"\n  ",
					),
				),
				Command.withHandler(() => server(make)),
			),
			{ version: "0.1.0" },
		).pipe(
			// @effect-diagnostics-next-line strictEffectProvide:off -- This program owns the whole application Layer scope.
			Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
		),
		// `server` logs a failed start with its annotations, and the command line
		// prints its own errors. The default report of runMain would log the same
		// failure again.
		{ disableErrorReporting: true },
	)
