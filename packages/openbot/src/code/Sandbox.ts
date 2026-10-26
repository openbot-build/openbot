import { fileURLToPath } from "node:url"
import { Worker } from "node:worker_threads"
import type { CodeRunsApi } from "@openbot-build/api"
import {
	Cause,
	Context,
	Duration,
	Effect,
	FileSystem,
	Layer,
	Option,
	Queue,
	Schema,
} from "effect"
import type {
	Call,
	FromWorker,
	Limits,
	Settled,
	ToWorker,
	VaultItem,
} from "./Protocol.ts"

export interface Program {
	readonly code: string
	readonly bindings: ReadonlyArray<string>
	/** The Vault items that the program can name. Without it, `vault` is empty. */
	readonly vault?: ReadonlyArray<VaultItem>
	readonly seed: number
	readonly clock: number
	readonly limits: Limits
}

/** How a run of a program ends. `Stopped` means that the host stopped it to wait for a decision. */
export type Outcome =
	| {
			readonly _tag: "Done"
			readonly value: Schema.Json
			readonly logs: ReadonlyArray<string>
	  }
	| {
			readonly _tag: "Failed"
			readonly reason: CodeRunsApi.FailureReason
			readonly message: string
			readonly logs: ReadonlyArray<string>
	  }
	| { readonly _tag: "Stopped" }

/**
 * Runs Code Mode programs. Each run gets its own worker thread with QuickJS in it,
 * and the worker ends with the run.
 */
export class Sandbox extends Context.Service<
	Sandbox,
	{
		/**
		 * Runs a program. `answer` gets each batch of App calls in the order of their index.
		 * It answers all of them, or none to stop the program.
		 */
		readonly run: <R>(
			program: Program,
			answer: (
				calls: ReadonlyArray<Call>,
			) => Effect.Effect<Option.Option<ReadonlyArray<Settled>>, never, R>,
		) => Effect.Effect<Outcome, never, R>
	}
>()("@openbot-build/openbot/code/Sandbox") {}

/**
 * The places of the worker file. Tests run the TypeScript source. The package
 * build has a JavaScript file next to this one. The single-file server bundle has
 * `CodeWorker.mjs` next to the bundle.
 */
const workerFiles = [
	new URL("./Worker.ts", import.meta.url),
	new URL("./Worker.js", import.meta.url),
	new URL("./CodeWorker.mjs", import.meta.url),
]

type Event =
	| { readonly _tag: "Message"; readonly message: FromWorker }
	| {
			readonly _tag: "Ended"
			readonly message: string
			/** The error of the worker, when an error stopped it. */
			readonly error?: unknown
			/** True when the worker used all the memory of its `resourceLimits`. */
			readonly outOfMemory?: boolean
	  }

const unavailable = (message: string): Outcome => ({
	_tag: "Failed",
	reason: "Unavailable",
	message,
	logs: [],
})

export const make: Effect.Effect<
	typeof Sandbox.Service,
	never,
	FileSystem.FileSystem
> = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	/** The first worker file that exists. */
	const workerFile = Effect.findFirst(workerFiles, (url) =>
		fs.exists(fileURLToPath(url)).pipe(
			Effect.tapCauseIf(Cause.hasFails, (cause) =>
				Effect.logWarning(
					"OpenBot could not check a file of the Code Mode worker.",
					cause,
				),
			),
			Effect.orElseSucceed(() => false),
		),
	)
	const run: typeof Sandbox.Service.run = (program, answer) =>
		Effect.scoped(
			Effect.gen(function* () {
				const file = yield* workerFile
				if (Option.isNone(file)) {
					yield* Effect.logError(
						"OpenBot could not find the Code Mode worker file.",
					)
					return unavailable("OpenBot could not find the Code Mode worker.")
				}
				const events = yield* Queue.unbounded<Event>()
				const worker = yield* Effect.acquireRelease(
					Effect.sync(() => {
						const worker = new Worker(file.value, {
							// The second limit on memory. QuickJS has its own, smaller limit.
							resourceLimits: {
								maxOldGenerationSizeMb:
									Math.ceil(program.limits.memoryBytes / (1024 * 1024)) + 64,
							},
						})
						worker.on("message", (message: FromWorker) => {
							Queue.offerUnsafe(events, { _tag: "Message", message })
						})
						worker.on("error", (error) => {
							Queue.offerUnsafe(events, {
								_tag: "Ended",
								message: error instanceof Error ? error.message : String(error),
								error,
								outOfMemory:
									typeof error === "object" &&
									error !== null &&
									"code" in error &&
									error.code === "ERR_WORKER_OUT_OF_MEMORY",
							})
						})
						worker.on("exit", (code) => {
							Queue.offerUnsafe(events, {
								_tag: "Ended",
								message:
									"The Code Mode worker stopped with exit code " + code + ".",
							})
						})
						return worker
					}),
					(worker) =>
						Effect.tryPromise(() => worker.terminate()).pipe(
							Effect.ignore({ log: "Debug" }),
						),
				)
				const post = (message: ToWorker) =>
					Effect.sync(() => worker.postMessage(message))
				// The worker counts only its own time. This guard also covers a worker that hangs.
				const guard = Duration.millis(program.limits.timeoutMs + 5_000)
				const next = Queue.take(events).pipe(Effect.timeoutOption(guard))
				yield* post({
					type: "start",
					code: program.code,
					bindings: program.bindings,
					vault: program.vault ?? [],
					seed: program.seed,
					clock: program.clock,
					limits: program.limits,
				})
				for (;;) {
					const event = yield* next
					if (Option.isNone(event)) {
						yield* Effect.logWarning(
							"The Code Mode worker did not answer in time, so OpenBot stopped it.",
						).pipe(Effect.annotateLogs({ timeoutMs: program.limits.timeoutMs }))
						return {
							_tag: "Failed",
							reason: "Timeout",
							message: "The program used all of its time.",
							logs: [],
						} satisfies Outcome
					}
					if (event.value._tag === "Ended") {
						// A worker that fails writes its full report to the server output before it stops.
						// The report and the exit code stay in the log. They are inside details.
						const { message, error, outOfMemory } = event.value
						yield* Effect.logWarning(
							"The Code Mode worker stopped before the program ended.",
							error === undefined ? message : Cause.die(error),
						)
						// The worker gets to its memory limit only through the data of the program.
						if (outOfMemory === true)
							return {
								_tag: "Failed",
								reason: "Memory",
								message: "The program used all of its memory.",
								logs: [],
							} satisfies Outcome
						return unavailable(
							"The Code Mode worker stopped before the program ended.",
						)
					}
					const message = event.value.message
					switch (message.type) {
						case "done": {
							const value = Schema.decodeOption(
								Schema.fromJsonString(Schema.Json),
							)(message.value)
							return Option.match(value, {
								onNone: () =>
									({
										_tag: "Failed",
										reason: "Error",
										message: "The program returned a value that is not JSON.",
										logs: message.logs,
									}) satisfies Outcome,
								onSome: (value) =>
									({
										_tag: "Done",
										value,
										logs: message.logs,
									}) satisfies Outcome,
							})
						}
						case "failed":
							return {
								_tag: "Failed",
								reason: message.reason,
								message: message.message,
								logs: message.logs,
							} satisfies Outcome
						case "calls": {
							const results = yield* answer(message.calls)
							if (Option.isNone(results))
								return { _tag: "Stopped" } satisfies Outcome
							yield* post({ type: "results", results: results.value })
						}
					}
				}
			}),
		).pipe(
			// A defect here is a bug of OpenBot, not of the program. The log keeps it, and the
			// client gets no inside details. The Turn goes on with an `Unavailable` result.
			Effect.catchDefect((defect) =>
				Effect.logError(
					"OpenBot could not run a Code Mode program.",
					Cause.die(defect),
				).pipe(Effect.as(unavailable("OpenBot could not run the program."))),
			),
		)
	return Sandbox.of({ run })
})

export const layer = Layer.effect(Sandbox, make)
