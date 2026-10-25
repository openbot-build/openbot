import { NodeRuntime } from "@effect/platform-node"
import { Effect, Layer } from "effect"
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

/** Runs `server` as the main program of the process. */
export const main = <ROut, E>(
	make: (
		settings: Configuration.Settings,
	) => Layer.Layer<ROut, E, HttpClient.HttpClient>,
) => NodeRuntime.runMain(server(make))
