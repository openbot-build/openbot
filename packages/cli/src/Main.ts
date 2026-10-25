#!/usr/bin/env node
import { NodeServices } from "@effect/platform-node"
import {
	Cause,
	Config,
	Console,
	Data,
	Effect,
	Option,
	PlatformError,
} from "effect"
import { Argument, Command } from "effect/cli"
import { ChildProcess } from "effect/process"
import * as Dispatch from "./Dispatch.ts"

/** The version of the openbot command. */
const version = "0.1.0"

/** How openbot ends: with an exit code, or with the signal that stopped the command. */
type Outcome = Data.TaggedEnum<{
	Code: { readonly code: number }
	Signal: { readonly signal: NodeJS.Signals }
}>
const Outcome = Data.taggedEnum<Outcome>()

const finish = (outcome: Outcome) =>
	Effect.sync(() =>
		Outcome.$match(outcome, {
			Code: ({ code }) => process.exit(code),
			Signal: ({ signal }) => {
				// Stop with the same signal as the command, so the caller sees the same result.
				process.removeAllListeners(signal)
				process.kill(process.pid, signal)
			},
		}),
	)

/**
 * While the command runs, openbot sends SIGTERM and SIGHUP on to it. The terminal
 * sends Ctrl-C to the command too, so openbot does nothing on SIGINT and waits for
 * the command to stop.
 */
const forwardSignals = (pid: number) =>
	Effect.acquireRelease(
		Effect.sync(() => {
			const handlers = {
				SIGINT: () => {},
				SIGTERM: () => process.kill(pid, "SIGTERM"),
				SIGHUP: () => process.kill(pid, "SIGHUP"),
			} as const
			for (const [signal, handler] of Object.entries(handlers))
				process.on(signal, handler)
			return handlers
		}),
		(handlers) =>
			Effect.sync(() => {
				for (const [signal, handler] of Object.entries(handlers))
					process.off(signal, handler)
			}),
	)

/**
 * The handle of @effect/platform-node 4.0.6 gives no signal when a command stops on
 * a signal. Its `exitCode` fails with an error whose cause names the signal in its
 * text, so this reads the signal from that text.
 */
const signalIn = (error: PlatformError.PlatformError) =>
	Option.fromNullishOr(
		error.reason.cause instanceof Error
			? (/signal: '(SIG[A-Z0-9]+)'/.exec(error.reason.cause.message)?.[1] as
					NodeJS.Signals | undefined)
			: undefined,
	)

const run = (file: string, args: ReadonlyArray<string>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const handle = yield* ChildProcess.make(file, args, {
				stdin: "inherit",
				stdout: "inherit",
				stderr: "inherit",
				// The command stays in the group of the terminal, so it can read input and gets Ctrl-C.
				detached: false,
			})
			yield* forwardSignals(handle.pid)
			return yield* handle.exitCode.pipe(
				Effect.map((code) => Outcome.Code({ code })),
				Effect.catch((error) =>
					Option.match(signalIn(error), {
						onNone: () => Effect.fail(error),
						onSome: (signal) => Effect.succeed(Outcome.Signal({ signal })),
					}),
				),
			)
		}),
	).pipe(
		Effect.catch((error) =>
			Console.error(`openbot: could not run ${file}: ${error.message}`).pipe(
				Effect.as(Outcome.Code({ code: 1 })),
			),
		),
	)

const showUsage = (folders: ReadonlyArray<string>) =>
	Dispatch.list(folders).pipe(
		Effect.flatMap((names) => Console.log(Dispatch.usage(names))),
		Effect.as(Outcome.Code({ code: 0 })),
	)

const runCommand = (
	name: string,
	folders: ReadonlyArray<string>,
	args: ReadonlyArray<string>,
) =>
	Dispatch.find(name, folders).pipe(
		Effect.flatMap(
			Option.match({
				onNone: () =>
					Console.error(Dispatch.unknown(name)).pipe(
						Effect.as(Outcome.Code({ code: 1 })),
					),
				onSome: (file) => run(file, args),
			}),
		),
	)

const openbot = Command.make(
	"openbot",
	{
		command: Argument.String("command").pipe(Argument.optional),
		arguments: Argument.String("arguments").pipe(Argument.variadic()),
	},
	({ command, arguments: args }) =>
		Effect.gen(function* () {
			const folders = yield* Dispatch.searchFolders({
				script: process.argv[1] ?? import.meta.filename,
				path: Option.getOrUndefined(
					yield* Config.option(Config.String("PATH")),
				),
			})
			const name = Option.getOrUndefined(command)
			const first = args[0]
			const outcome =
				name === undefined || name === "--help" || name === "-h"
					? yield* showUsage(folders)
					: name !== "help"
						? yield* runCommand(name, folders, args)
						: first === undefined
							? yield* showUsage(folders)
							: yield* runCommand(first, folders, ["--help"])
			return yield* finish(outcome)
		}),
).pipe(Command.withDescription("Run and control OpenBot."))

// openbot gives every argument to the command without a change. The `--` makes
// the parser take all of them as plain values, and not as flags of openbot.
const argv = process.argv.slice(2)
const program = Command.runWith(openbot, { version })(
	argv.length === 0 ? [] : ["--", ...argv],
).pipe(
	// The parser has already shown its errors.
	Effect.catch(() => finish(Outcome.Code({ code: 1 }))),
	Effect.catchDefect((defect) =>
		Console.error(Cause.pretty(Cause.die(defect))).pipe(
			Effect.andThen(finish(Outcome.Code({ code: 1 }))),
		),
	),
)

// This is the entry point, so it gives every service at once. It does not use
// NodeRuntime.runMain, because runMain stops the program on SIGINT, and openbot must
// wait for the command to stop.
// @effect-diagnostics-next-line strictEffectProvide:off
Effect.runFork(program.pipe(Effect.provide(NodeServices.layer)))
