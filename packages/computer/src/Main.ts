#!/usr/bin/env node
import { NodeRuntime, NodeServices, NodeSocket } from "@effect/platform-node"
import { Console, Effect, Layer, Option } from "effect"
import { Command, Flag } from "effect/cli"
import { FetchHttpClient } from "effect/http"
import * as Config from "./Config.ts"
import * as Connect from "./Connect.ts"
import * as Machine from "./Machine.ts"
import * as Pair from "./Pair.ts"

const notPaired = new Config.ComputerError({
	message:
		"This machine is not paired. Run 'openbot computer pair --url <address of OpenBot>' first.",
})

const readSaved = (file: string) =>
	Config.read(file).pipe(
		Effect.flatMap(
			Option.match({
				onNone: () => Effect.fail(notPaired),
				onSome: Effect.succeed,
			}),
		),
	)

const pair = Command.make("pair", {
	url: Flag.String("url").pipe(
		Flag.withDescription(
			"The address of OpenBot, such as https://openbot.example.com.",
		),
	),
}).pipe(
	Command.withDescription(
		"Pair this machine with OpenBot. A person approves the code that it shows. Then it saves a token.",
	),
	Command.withHandler(({ url }) =>
		Effect.gen(function* () {
			const file = Config.path()
			const { computer } = yield* Pair.pair({
				url,
				file,
				output: {
					showCode: (pairing, approveUrl) =>
						Console.log(
							[
								`The pairing code is ${pairing.code}.`,
								"Approve it in your OpenBot client, or send this request with your API key:",
								`  POST ${approveUrl}`,
								`The code works until ${new Date(pairing.expiresAt).toLocaleTimeString()}.`,
								"Waiting for approval...",
							].join("\n"),
						),
				},
			})
			yield* Console.log(
				[
					`OpenBot approved this machine. It is the Computer ${computer}.`,
					`The token is saved in ${file}.`,
					"Run 'openbot computer connect' to connect this machine.",
				].join("\n"),
			)
		}),
	),
)

const connect = Command.make("connect").pipe(
	Command.withDescription(
		"Connect this machine to OpenBot and do the work that Bots send. It connects again when the connection is lost.",
	),
	Command.withHandler(() =>
		Effect.gen(function* () {
			const config = yield* readSaved(Config.path())
			yield* Console.log(`Connecting to ${config.url}...`)
			return yield* Connect.connect({
				config,
				events: {
					connected: Console.log("Connected. Bots can use this machine now."),
					disconnected: (reason, retryInMs) =>
						Console.error(
							`The connection is lost (${reason}). Trying again in ${Math.round(retryInMs / 1000)} s.`,
						),
				},
			})
		}),
	),
)

const status = Command.make("status").pipe(
	Command.withDescription(
		"Show the OpenBot address and the machine ID. It never shows the token.",
	),
	Command.withHandler(() =>
		Effect.gen(function* () {
			const file = Config.path()
			const config = yield* readSaved(file)
			yield* Console.log(
				[
					`OpenBot: ${config.url}`,
					`Machine ID: ${config.machineId}`,
					`Config file: ${file}`,
				].join("\n"),
			)
		}),
	),
)

const computer = Command.make("openbot-computer").pipe(
	Command.withDescription(
		"Connect a machine of your own to OpenBot as a Computer. Run it as 'openbot computer'.",
	),
	Command.withSubcommands([pair, connect, status]),
)

const program = Command.run(computer, { version: Machine.version }).pipe(
	Effect.catchTag("ComputerError", (error) =>
		Console.error(error.message).pipe(
			Effect.andThen(Effect.sync(() => (process.exitCode = 1))),
		),
	),
)

NodeRuntime.runMain(
	program.pipe(
		// This is the entry point, so it gives every service at once.
		// The `ws` WebSocket can send the Authorization header. The global WebSocket cannot.
		// @effect-diagnostics-next-line strictEffectProvide:off
		Effect.provide(
			Layer.mergeAll(
				NodeServices.layer,
				FetchHttpClient.layer,
				NodeSocket.layerWebSocketConstructorWS,
			),
		),
	),
)
