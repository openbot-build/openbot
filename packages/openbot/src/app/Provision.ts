import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Console, Effect, FileSystem, Layer, Redacted, Schema } from "effect"
import { Command, Flag } from "effect/cli"
import * as EnvironmentConfiguration from "../configuration/EnvironmentConfiguration.ts"
import * as SecretFiles from "../configuration/SecretFiles.ts"
import * as Provision from "../platform/Provision.ts"
import * as OpenBot from "./OpenBot.ts"

const services = Layer.unwrap(
	Effect.map(EnvironmentConfiguration.load, (config) =>
		Provision.layer.pipe(Layer.provideMerge(OpenBot.layerShared(config))),
	),
)
const command = Command.make("openbot provision", {
	input: Flag.String("input").pipe(
		Flag.withDescription(
			"A private JSON file for a new, empty database. Its file mode must be 0600 or stricter.",
		),
	),
}).pipe(
	Command.withDescription(
		"Set up sign-in, one organization, personal Bots and models. The server must be stopped. This command never imports old work or calls a model.",
	),
	Command.withHandler(({ input }) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const info = yield* fs.stat(input)
			if (
				info.type !== "File" ||
				(info.mode & 0o077) !== 0 ||
				info.size > 2n * 1024n * 1024n
			)
				return yield* Provision.ProvisionInvalid.make({
					message: "Use a private file no larger than 2 MiB.",
				})
			const text = yield* fs.readFileString(input)
			const value = yield* Schema.decodeEffect(
				Schema.fromJsonString(Provision.Input),
			)(text, { onExcessProperty: "error" })
			const result = yield* Provision.run(value)
			yield* Console.log(
				yield* Schema.encodeEffect(Schema.fromJsonString(Provision.Result))(
					result,
				),
			)
		}).pipe(
			// @effect-diagnostics-next-line strictEffectProvide:off -- This command owns the whole storage Layer scope.
			Effect.provide(services.pipe(Layer.provide(SecretFiles.layer()))),
			Effect.catchCause((cause) =>
				Effect.logError("Provision failed.", Redacted.make(cause)).pipe(
					Effect.andThen(
						Effect.fail(
							Provision.ProvisionInvalid.make({
								message:
									"Setup did not finish. The transaction was rolled back. Check the private input and the empty target.",
							}),
						),
					),
				),
			),
		),
	),
)

NodeRuntime.runMain(
	Command.run(command, { version: "0.1.0" }).pipe(
		// @effect-diagnostics-next-line strictEffectProvide:off -- This program owns the Node services used by the command.
		Effect.provide(NodeServices.layer),
	),
)
