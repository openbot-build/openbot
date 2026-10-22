import {
	Cause,
	Duration,
	Effect,
	Layer,
	PubSub,
	Schedule,
	Scope,
	Stream,
} from "effect"
import { Signals, type Signal } from "../agents/Signals.ts"
import { Launcher } from "./Execution.ts"
import { Runs } from "./Runs.ts"
import { Tasks } from "./Tasks.ts"
import { Workflows } from "./Workflows.ts"

export interface Options {
	/** How often the worker starts scheduled Runs and checks waiting Runs. The default is 15 seconds. */
	readonly interval?: Duration.Input
}

const ended = (status: string) =>
	status === "Completed" || status === "Failed" || status === "Interrupted"

/**
 * Keeps Runs going: it wakes a Run when the Turn that it waits for ends, starts the Runs
 * of schedules, and after a restart starts again the Runs that were open. A lost signal
 * only makes a Run wait until the next check.
 */
export const layer = (options: Options = {}) =>
	Layer.effectDiscard(
		Effect.gen(function* () {
			const signals = yield* Signals
			const runs = yield* Runs
			const tasks = yield* Tasks
			const launcher = yield* Launcher
			const workflows = yield* Workflows
			const scope = yield* Scope.Scope
			const onTurn = (signal: Extract<Signal, { _tag: "TurnChanged" }>) =>
				ended(signal.status)
					? runs.waitingOn(signal.session).pipe(
							Effect.flatMap((list) =>
								Effect.forEach(list, (run) => tasks.wake(run), {
									discard: true,
								}),
							),
						)
					: Effect.void
			const handle = (signal: Signal) =>
				(signal._tag === "TurnChanged" ? onTurn(signal) : Effect.void).pipe(
					Effect.catchCause((cause) =>
						Cause.hasInterruptsOnly(cause)
							? Effect.void
							: Effect.logWarning("A Workflow signal failed", cause),
					),
				)
			/** Runs that wait, or that never started, get one more push. */
			const check = Effect.gen(function* () {
				const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
				for (const run of yield* runs.open) {
					if (run.waiting !== null) yield* tasks.wake(run)
					else if (run.status === "queued" && now - run.createdAt > 30_000)
						yield* launcher.resume(run)
				}
			})
			const schedules = Effect.gen(function* () {
				for (const due of yield* workflows.due) {
					const actor = due.workflow.actor
					if (actor === null) continue
					yield* launcher
						.start({
							organizationId: due.organizationId,
							userId: actor,
							trigger: "schedule",
							input: {},
							cache: "use",
							source: { _tag: "Workflow", workflow: due.workflow },
						})
						.pipe(
							Effect.catchCause((cause) =>
								Effect.logWarning("A scheduled Run could not start", cause),
							),
						)
				}
			})
			const subscription = yield* PubSub.subscribe(signals.pubsub)
			yield* Stream.fromSubscription(subscription).pipe(
				Stream.runForEach((signal) => Effect.forkIn(handle(signal), scope)),
				Effect.forkScoped,
			)
			// After a start, Runs that were open go on.
			yield* runs.open.pipe(
				Effect.flatMap((open) =>
					Effect.forEach(open, (run) =>
						run.waiting === null ? launcher.resume(run) : tasks.wake(run),
					),
				),
				Effect.catchCause((cause) =>
					Effect.logWarning("Open Workflow Runs could not go on", cause),
				),
				Effect.forkScoped,
			)
			yield* Effect.all([schedules, check], { discard: true }).pipe(
				Effect.catchCause((cause) =>
					Effect.logWarning("The Workflow worker failed", cause),
				),
				Effect.repeat(
					Schedule.spaced(options.interval ?? Duration.seconds(15)),
				),
				Effect.forkScoped,
			)
		}),
	)
