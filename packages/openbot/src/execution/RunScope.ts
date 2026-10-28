import * as Admission from "./Admission.ts"
import { Observation } from "./Observation.ts"
import { Execution } from "@openbot-build/domain"
import {
	Array as Arr,
	Cause,
	Clock,
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	Ref,
	Schedule,
	Schema,
	Scope,
	Stream,
} from "effect"
import {
	Activity,
	DurableClock,
	DurableDeferred,
	WorkflowEngine,
} from "effect/workflow"
import { Records, category } from "../errors/Records.ts"
import * as Recovery from "./Recovery.ts"
import { cancelSignal, signal } from "./Engine.ts"
import { Store, type Fence } from "./Store.ts"

const WorkResult = Schema.Union([
	Admission.Paused,
	Schema.TaggedStruct("Done", {}),
	Schema.TaggedStruct("Failed", { failure: Execution.Failure }),
])
const Result = Schema.Union([
	WorkResult,
	Schema.TaggedStruct("Cancelled", { epoch: Schema.Int }),
	Schema.TaggedStruct("Expired", {}),
	Schema.TaggedStruct("Decided", { id: Schema.String }),
	Schema.TaggedStruct("Changed", {}),
])

export interface Options {
	readonly deadline?: number
	readonly decisionId?: string
	readonly afterSequence?: number
}

export interface Service {
	readonly run: <E = never, R = never>(
		fence: Fence,
		name: string,
		work: Effect.Effect<void, E, R | Scope.Scope> | undefined,
		options?: Options,
	) => Effect.Effect<
		| { readonly _tag: "Done" }
		| { readonly _tag: "Failed"; readonly failure: Execution.Failure }
		| { readonly _tag: "Cancelled"; readonly epoch: number }
		| { readonly _tag: "Expired" }
		| { readonly _tag: "Decided"; readonly id: string }
		| { readonly _tag: "Changed" },
		Execution.Conflict | Execution.NotFound | Execution.StorageError,
		| WorkflowEngine.WorkflowEngine
		| WorkflowEngine.WorkflowInstance
		| Exclude<R, Scope.Scope>
	>
}

export class RunScope extends Context.Service<RunScope, Service>()(
	"@openbot-build/openbot/execution/RunScope",
) {}

const make = Effect.gen(function* () {
	const observation = yield* Observation
	const store = yield* Store
	const errors = yield* Records
	const recovery = yield* Recovery.Recovery
	/** A phase name comes from a saved step or attempt, never a process or fiber ID. */
	const phaseRun = <E = never, R = never>(
		fence: Fence,
		name: string,
		work: Effect.Effect<void, E, R | Scope.Scope> | undefined,
		options?: Options,
	) =>
		Effect.gen(function* () {
			const before = yield* store.load(fence)
			if (
				before.generation !== fence.generation ||
				Execution.isTerminal(before.record.status)
			)
				return yield* Execution.Conflict.make({ id: fence.id })
			if (
				before.phaseFailed &&
				before.record.failure !== null &&
				work !== undefined
			)
				return { _tag: "Failed", failure: before.record.failure } as const
			// Read business state before a cached race. A new owner may see cancel
			// before the old owner could save its race result.
			if (before.record.status === "cancelling")
				return { _tag: "Cancelled", epoch: before.cancelEpoch } as const
			const remaining =
				options?.deadline === undefined
					? undefined
					: options.deadline - (yield* Clock.currentTimeMillis)
			if (remaining !== undefined && remaining <= 0)
				return { _tag: "Expired" } as const
			const epoch = before.cancelEpoch + 1
			const phase = `${name.length}:${name}:owner:${fence.generation}:cancel:${epoch}:after:${options?.afterSequence ?? "none"}`
			const pause = yield* Deferred.make<Admission.Paused>()
			const stopped = Deferred.await(pause)
			const owner = yield* Ref.make<
				"ready" | "closed" | Fiber.Fiber<unknown, unknown>
			>("ready")
			// Cluster Activity abort only sends an RPC interrupt. It does not wait for
			// the server fiber. Keep that local fiber until its resource scope closes.
			const owned = <E, R>(work: Effect.Effect<typeof WorkResult.Type, E, R>) =>
				Effect.uninterruptibleMask((restore) =>
					Effect.withFiber((fiber) =>
						Effect.gen(function* () {
							const start = yield* Ref.modify(owner, (current) =>
								current === "ready" ? [true, fiber] : [false, current],
							)
							// Cancellation can win before the Activity RPC starts its body.
							if (!start) return { _tag: "Done" } as const
							return yield* restore(work).pipe(
								Effect.ensuring(
									Ref.update(owner, (current) =>
										current === fiber ? "ready" : current,
									),
								),
							)
						}),
					),
				)
			const closeWork = Ref.getAndSet(owner, "closed").pipe(
				Effect.flatMap((current) =>
					typeof current === "string" ? Effect.void : Fiber.interrupt(current),
				),
			)
			const scopedWork =
				work === undefined
					? undefined
					: Effect.scoped(
							Effect.uninterruptibleMask((restore) =>
								Effect.gen(function* () {
									const resources = yield* Scope.make()
									const fiber = yield* work.pipe(
										Effect.provideService(Scope.Scope, resources),
										Effect.provideService(Admission.CurrentPhase, (value) =>
											Deferred.succeed(pause, value).pipe(
												Effect.andThen(Effect.never),
											),
										),
										Effect.forkScoped({ uninterruptible: false }),
									)
									// A losing race must close resources and save the full cause before it ends.
									yield* Effect.addFinalizer(() =>
										Effect.gen(function* () {
											yield* Fiber.interrupt(fiber)
											const ended = yield* Fiber.await(fiber)
											const closed = yield* Effect.exit(
												Scope.close(resources, ended),
											)
											const cause = Cause.combine(
												Exit.isFailure(ended) ? ended.cause : Cause.empty,
												Exit.isFailure(closed) ? closed.cause : Cause.empty,
											)
											if (
												cause.reasons.length === 0 ||
												Cause.hasInterruptsOnly(cause)
											)
												return
											// Retry a work storage failure before deciding that the phase failed.
											if (Exit.isSuccess(closed) && !Cause.hasInterrupts(cause))
												return
											// A pause is a control signal, not a failed phase.
											if (
												cause.reasons.length === 1 &&
												cause.reasons[0]?._tag === "Fail" &&
												Schema.is(Admission.Paused)(cause.reasons[0].error)
											)
												return
											const failure = yield* recovery.record(cause, fence.id)
											yield* recovery
												.storage(fence.id, store.failPhase(fence, failure))
												.pipe(
													Effect.catchTag(
														"ExecutionConflict",
														() => Effect.void,
													),
												)
										}).pipe(Effect.orDie),
									)
									const result = yield* restore(
										Effect.raceFirst(Fiber.await(fiber), stopped),
									)
									if (result._tag === "ExecutionPaused") return result
									yield* result
									return { _tag: "Done" } as const
								}),
							),
						)
			const effects: Arr.NonEmptyReadonlyArray<
				Effect.Effect<
					typeof Result.Type,
					never,
					| WorkflowEngine.WorkflowInstance
					| WorkflowEngine.WorkflowEngine
					| Exclude<R, Scope.Scope>
				>
			> = [
				DurableDeferred.await(cancelSignal(epoch)).pipe(
					Effect.as({ _tag: "Cancelled", epoch } as const),
				),
				...(scopedWork === undefined
					? []
					: [
							Activity.make({
								name: `work:${phase}`,
								success: WorkResult,
								execute: recovery.storage(fence.id, scopedWork).pipe(
									Effect.catchCause(
										(cause): Effect.Effect<typeof WorkResult.Type> => {
											const reason = cause.reasons[0]
											if (
												cause.reasons.length === 1 &&
												reason?._tag === "Fail" &&
												Schema.is(Admission.Paused)(reason.error)
											)
												return Effect.succeed(reason.error)
											if (Cause.hasInterruptsOnly(cause))
												return Effect.failCause(
													Cause.fromReasons<never>(
														Arr.filter(cause.reasons, Cause.isInterruptReason),
													),
												)
											// A race picks the first success. Save ordinary failures as safe
											// values, or a failed phase would wait forever for cancellation.
											return store.load(fence).pipe(
												Effect.flatMap(
													(
														state,
													): Effect.Effect<
														typeof WorkResult.Type,
														Execution.NotFound | Execution.StorageError
													> => {
														if (
															state.generation === fence.generation &&
															state.record.status === "cancelling" &&
															!state.phaseFailed &&
															cause.reasons.length > 0 &&
															Arr.every(
																cause.reasons,
																(reason) =>
																	reason._tag === "Fail" &&
																	Schema.is(Execution.Conflict)(reason.error),
															)
														) {
															// The cancel state can reach a write before its signal arrives.
															// Resources are closed. The state read below returns Cancelled.
															return Effect.succeed({ _tag: "Done" } as const)
														}
														return (
															!state.phaseFailed ||
															state.record.failure === null
																? errors.record(
																		cause,
																		category(cause),
																		fence.id,
																	)
																: Effect.succeed(state.record.failure)
														).pipe(
															Effect.tap((failure) =>
																recovery
																	.commit(
																		fence.id,
																		store.failPhase(fence, failure),
																	)
																	.pipe(
																		Effect.catchTag(
																			"ExecutionConflict",
																			() => Effect.void,
																		),
																	),
															),
															Effect.map(
																(failure) =>
																	({ _tag: "Failed", failure }) as const,
															),
														)
													},
												),
												Effect.retry(Schedule.exponential("100 millis")),
												Effect.orDie,
											)
										},
									),
									owned,
								),
							}),
						]),
				...(options?.decisionId === undefined
					? []
					: [
							DurableDeferred.await(signal(options.decisionId)).pipe(
								Effect.as({ _tag: "Decided", id: options.decisionId } as const),
							),
						]),
				...(options?.afterSequence === undefined
					? []
					: [
							DurableDeferred.into(
								recovery
									.storage(
										fence.id,
										observation
											.observe(fence, options.afterSequence)
											.pipe(Stream.take(1), Stream.runDrain),
									)
									.pipe(Effect.orDie, Effect.as({ _tag: "Changed" } as const)),
								DurableDeferred.make(`changed:${phase}`, {
									success: Schema.TaggedStruct("Changed", {}),
								}),
							),
						]),
				...(remaining === undefined
					? []
					: [
							DurableClock.sleep({
								name: `deadline:${phase}`,
								duration: remaining,
								inMemoryThreshold: 0,
							}).pipe(Effect.as({ _tag: "Expired" } as const)),
						]),
			]
			const result = yield* DurableDeferred.raceAll({
				name: phase,
				success: Result,
				error: Schema.Never,
				effects,
			}).pipe(Effect.ensuring(closeWork))

			// The race waits for the losing scope to close. A cancel transaction
			// can win just after work ends but before its business state commits.
			const after = yield* store.load(fence)
			if (after.generation !== fence.generation)
				return yield* Execution.Conflict.make({ id: fence.id })
			if (
				after.phaseFailed &&
				after.record.failure !== null &&
				work !== undefined
			)
				return { _tag: "Failed", failure: after.record.failure } as const
			return after.record.status === "cancelling"
				? ({ _tag: "Cancelled", epoch: after.cancelEpoch } as const)
				: result
		})
	const run = <E = never, R = never>(
		fence: Fence,
		name: string,
		work: Effect.Effect<void, E, R | Scope.Scope> | undefined,
		options?: Options,
	) =>
		Effect.gen(function* () {
			let phase = name
			while (true) {
				const result = yield* phaseRun(fence, phase, work, options)
				if (result._tag !== "ExecutionPaused") return result
				const key = `${result.namespace.length}:${result.namespace}:${result.id}:${result.afterSequence}`
				// Scope release precedes this wait. Read from the saved cursor so a lost wake is safe.
				const waited = yield* phaseRun(
					fence,
					`${name}:wait:${key}`,
					observation
						.observe(result, result.afterSequence)
						.pipe(Stream.take(1), Stream.runDrain),
					options,
				)
				if (waited._tag !== "Done" && waited._tag !== "ExecutionPaused")
					return waited
				phase = `${name}:resume:${key}`
			}
		})
	return RunScope.of({ run })
})

export const layer = Layer.effect(RunScope, make).pipe(
	Layer.provide(Recovery.layer),
)
