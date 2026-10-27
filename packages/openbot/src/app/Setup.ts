import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { Command } from "effect/cli"
import * as EnvironmentConfiguration from "../configuration/EnvironmentConfiguration.ts"
import * as SecretFiles from "../configuration/SecretFiles.ts"
import * as PlatformAdminsPostgres from "../platform/PlatformAdminsPostgres.ts"
import * as Setup from "../platform/Setup.ts"
import * as OpenBot from "./OpenBot.ts"
import * as SetupCommand from "./SetupCommand.ts"

const services = Layer.unwrap(
	Effect.map(EnvironmentConfiguration.load, (instance) =>
		PlatformAdminsPostgres.layer.pipe(
			Layer.provideMerge(OpenBot.layerShared(instance)),
		),
	),
)

// Load database services only after parsing: --help works without database settings.
const setup = SetupCommand.make((input) =>
	Setup.run(input).pipe(
		Effect.catchTag("SetupAlreadyDone", () =>
			Effect.fail(
				Setup.SetupInvalid.make({
					message:
						"The platform already has other settings. Change them through PATCH /v1/platform/settings, or run setup again with --force.",
				}),
			),
		),
		// @effect-diagnostics-next-line strictEffectProvide:off -- This program owns the whole application Layer scope.
		Effect.provide(services),
	),
)
NodeRuntime.runMain(
	Command.run(setup, { version: "0.1.0" }).pipe(
		// Config fallback flags are parsed before the handler. Secret files must cover both.
		// @effect-diagnostics-next-line strictEffectProvide:off -- This program owns the whole application Layer scope.
		Effect.provide(
			SecretFiles.layer().pipe(Layer.provideMerge(NodeServices.layer)),
		),
	),
)
