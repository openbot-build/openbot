import { Execution } from "@openbot-build/domain"
import {
	Array as Arr,
	Crypto,
	Effect,
	type PlatformError,
	Stream,
} from "effect"
import { prepare, type Command } from "./Command.ts"
export type { Command } from "./Command.ts"
import { Client, type ClientError } from "./Client.ts"

/** Make one cancel command. Every send and network retry uses the same key. */
export const cancel = Effect.fn("Executions.cancel")(function* (
	executionId: Execution.Id,
	commandKey?: Execution.CommandKey,
): Effect.fn.Return<
	Command<Execution.Receipt, ClientError>,
	PlatformError.PlatformError,
	Client | Crypto.Crypto
> {
	const { api } = yield* Client
	return yield* prepare(
		(key) =>
			api.executions.cancel({
				params: { executionId },
				payload: { commandKey: key },
			}),
		commandKey,
	)
})

/** Make one decision command. Reuse its send effect if the reply is lost. */
export const decide = Effect.fn("Executions.decide")(function* (
	executionId: Execution.Id,
	input: {
		readonly decisionId: string
		readonly answer: Execution.Answer
		readonly commandKey?: Execution.CommandKey
	},
): Effect.fn.Return<
	Command<Execution.Receipt, ClientError>,
	PlatformError.PlatformError,
	Client | Crypto.Crypto
> {
	const { api } = yield* Client
	return yield* prepare(
		(key) =>
			api.executions.decide({
				params: { executionId },
				payload: {
					commandKey: key,
					decisionId: input.decisionId,
					answer: input.answer,
				},
			}),
		input.commandKey,
	)
})

export type ObservationError =
	| ClientError
	| Stream.Error<
			Effect.Success<
				ReturnType<(typeof Client.Service)["api"]["executions"]["observe"]>
			>
	  >

/** The caller can resume one execution from its last saved sequence. */
export const observe = (
	executionId: Execution.Id,
	afterSequence = 0,
): Stream.Stream<Execution.Event, ObservationError, Client> =>
	Stream.unwrap(
		Effect.map(Client, ({ api }) =>
			Stream.unwrap(
				api.executions.observe({
					params: { executionId },
					query: { afterSequence },
				}),
			).pipe(Stream.map((event) => event.data)),
		),
	)

/** Child cursors belong to each child. A parent may finish while a child waits for a decision. */
export const observeTree = (
	executionId: Execution.Id,
	options: { readonly stopAt?: ReadonlyArray<string> } = {},
): Stream.Stream<Execution.Event, ObservationError, Client> =>
	Stream.unwrap(
		Effect.gen(function* () {
			const { api } = yield* Client
			const leaf =
				options.stopAt === undefined
					? false
					: Arr.contains(
							options.stopAt,
							(yield* api.executions.get({ params: { executionId } })).resource
								.kind,
						)
			return observe(executionId).pipe(
				Stream.flatMap(
					(event): Stream.Stream<Execution.Event, ObservationError, Client> =>
						!leaf && event.body._tag === "ChildExecution"
							? Stream.concat(
									Stream.succeed(event),
									observeTree(event.body.executionId, options),
								)
							: Stream.succeed(event),
					{ concurrency: "unbounded" },
				),
			)
		}),
	)
