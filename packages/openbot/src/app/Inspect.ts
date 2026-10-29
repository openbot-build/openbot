import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Console, Effect, Layer } from "effect"
import { Command } from "effect/cli"
import * as Administration from "../platform/Administration.ts"
import * as EnvironmentConfiguration from "../configuration/EnvironmentConfiguration.ts"
import * as SecretFiles from "../configuration/SecretFiles.ts"
import * as OpenBot from "./OpenBot.ts"

const services = Layer.unwrap(
	Effect.map(EnvironmentConfiguration.load, OpenBot.layerShared),
).pipe(Layer.provide(SecretFiles.layer()))
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
)
NodeRuntime.runMain(
	Command.run(program, { version: "0.1.0" }).pipe(
		// @effect-diagnostics-next-line strictEffectProvide:off -- This command owns its platform Layer scope.
		Effect.provide(NodeServices.layer),
	),
)
