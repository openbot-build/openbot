#!/usr/bin/env node
import { NodeRuntime, NodeServices, NodeSocket } from "@effect/platform-node"
import { Array as Arr, Console, DateTime, Effect, Layer, Option } from "effect"
import { Command, Flag } from "effect/cli"
import { FetchHttpClient } from "effect/http"
import * as Config from "./Config.ts"
import * as Connect from "./Connect.ts"
import * as Machine from "./Machine.ts"
import * as Pair from "./Pair.ts"

const notPaired = Config.ComputerError.make({
	message:
		"This machine is not paired. Run 'openbot computer pair --url <address of OpenBot>' first.",
})

/**
 * The time in the local time zone, in the same form as `Date.toLocaleTimeString`.
 * OpenBot sends the time, so it can be out of the range of a date.
 */
const localTime = (ms: number): string =>
	Option.match(DateTime.make(ms), {
		onNone: () => "an unknown time",
		onSome: (time) => DateTime.formatLocal(time, { timeStyle: "medium" }),
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
			const file = yield* Config.path
			const { computer } = yield* Pair.pair({
				url,
				file,
				output: {
					showCode: (pairing, approveUrl) =>
						Console.log(
							Arr.join(
								[
									`The pairing code is ${pairing.code}.`,
									"Approve it in your OpenBot client, or send this request with your API key:",
									`  POST ${approveUrl}`,
									`The code works until ${localTime(pairing.expiresAt)}.`,
									"Waiting for approval...",
								],
								"\n",
							),
						),
				},
			})
			yield* Console.log(
				Arr.join(
					[
						`OpenBot approved this machine. It is the Computer ${computer}.`,
						`The token is saved in ${file}.`,
						"Run 'openbot computer connect' to connect this machine.",
					],
					"\n",
				),
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
			const config = yield* readSaved(yield* Config.path)
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
			const file = yield* Config.path
			const config = yield* readSaved(file)
			yield* Console.log(
				Arr.join(
					[
						`OpenBot: ${config.url}`,
						`Machine ID: ${config.machineId}`,
						`Config file: ${file}`,
					],
					"\n",
				),
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
		// The `ws` WebSocket can send the Authorization header. The global WebSocket cannot.
		// @effect-diagnostics-next-line strictEffectProvide:off -- This is the entry point, so it gives every service at once.
		Effect.provide(
			Layer.mergeAll(
				NodeServices.layer,
				FetchHttpClient.layer,
				NodeSocket.layerWebSocketConstructorWS,
			),
		),
	),
)
