import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { Command } from "effect/cli"
import { FetchHttpClient, type HttpClient } from "effect/http"
import type * as Configuration from "../configuration/Configuration.ts"
import * as EnvironmentConfiguration from "../configuration/EnvironmentConfiguration.ts"
import * as SecretFiles from "../configuration/SecretFiles.ts"
import * as OutboundGuard from "../network/OutboundGuard.ts"
import * as ErrorReporting from "./ErrorReporting.ts"

/**
 * Runs a server as the `openbot-server` program does. It reads the settings from
 * the environment and from secret files, blocks outbound connections to private
 * addresses, and logs a failed start. `make` gives the server, such as
 * `Server.layer`. It runs until the process stops.
 */
export const server = <ROut, E>(
	make: (
		settings: Configuration.Settings,
	) => Layer.Layer<ROut, E, HttpClient.HttpClient>,
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
		// This program owns the whole application Layer scope.
		// @effect-diagnostics-next-line strictEffectProvide:off
		Effect.provide(SecretFiles.layer()),
	)

/**
 * Runs `server` as the main program of the process. It reads the command line
 * first, so `--help` and `--version` work without any settings.
 */
export const main = <ROut, E>(
	make: (
		settings: Configuration.Settings,
	) => Layer.Layer<ROut, E, HttpClient.HttpClient>,
) =>
	NodeRuntime.runMain(
		Command.run(
			Command.make("openbot server").pipe(
				Command.withDescription(
					[
						"Run the OpenBot HTTP server.",
						"It takes its settings from these environment variables:",
						"  OPENBOT_DATABASE_URL    The address of the Postgres database. Needed.",
						"  OPENBOT_SECRET_KEYS     The keys that keep stored secrets safe. Needed.",
						"  OPENBOT_HOST            The address to listen on. The default is 127.0.0.1.",
						"  OPENBOT_PORT            The port to listen on. The default is 3000.",
						"  OPENBOT_OUTBOUND_ALLOW  The private addresses that OpenBot may connect to.",
						"A variable can also come from the file /run/secrets/<NAME>.",
						// Effect CLI indents only the first line of a description, so the other lines get the indent here.
					].join("\n  "),
				),
				Command.withHandler(() => server(make)),
			),
			{ version: "0.1.0" },
		).pipe(
			// This program owns the whole application Layer scope.
			// @effect-diagnostics-next-line strictEffectProvide:off
			Effect.provide(NodeServices.layer),
		),
	)
