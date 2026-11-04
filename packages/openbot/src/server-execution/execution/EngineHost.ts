import { Execution } from "@openbot-build/domain"
import {
	Array as Arr,
	Cause,
	Context,
	Duration,
	Effect,
	Exit,
	HashMap,
	Layer,
	Option,
	Ref,
	Schedule,
	Schema,
	Scope,
	Stream,
} from "effect"
import { HttpRunner, ShardingConfig } from "effect/cluster"
import {
	HttpRouter,
	type HttpServerRequest,
	HttpServerResponse,
} from "effect/http"
import { RpcSerialization } from "effect/rpc"
import { WorkflowEngine } from "effect/workflow"
import { Records } from "../../server-kernel/errors/Records.ts"
import * as Report from "../../server-kernel/errors/Report.ts"
import * as Background from "../../server-kernel/execution/Background.ts"
import * as PrivateRpc from "../transport/PrivateRpc.ts"
import * as Engine from "./Engine.ts"
import { Store } from "./Store.ts"
import { type Contribution, Workflows } from "./Workflows.ts"

type RpcHandler = Effect.Effect<
	HttpServerResponse.HttpServerResponse,
	never,
	Scope.Scope | HttpServerRequest.HttpServerRequest
>

/** The RPC handler of the open engine generation, when one is open. */
export class EngineRpc extends Context.Service<
	EngineRpc,
	Ref.Ref<Option.Option<RpcHandler>>
>()("@openbot-build/openbot/server-execution/execution/EngineHost/EngineRpc") {}

export const layerRpc = Layer.effect(
	EngineRpc,
	Ref.make(Option.none<RpcHandler>()),
)

/**
 * The router gets this route once. It sends each call to the open
 * generation. With no open generation it answers 503, and the peer sends the
 * call again.
 */
export const layerRoutes = Layer.effectDiscard(
	Effect.gen(function* () {
		const router = yield* HttpRouter.HttpRouter
		const gate = yield* PrivateRpc.make
		const current = yield* EngineRpc
		yield* router.add(
			"POST",
			Engine.path,
			gate.protect(
				Effect.flatMap(
					Ref.get(current),
					Option.match({
						onNone: () =>
							Effect.succeed(HttpServerResponse.empty({ status: 503 })),
						onSome: (handler) => handler,
					}),
				),
			),
		)
	}),
)

/** No database lock is held while the engine stores a command. Redelivery is safe. */
const outbox = (hosted: HashMap.HashMap<string, Contribution>) =>
	Effect.gen(function* () {
		const background = yield* Background.make
		const store = yield* Store
		const workflows = yield* Workflows
		const errors = yield* Records
		const engine = yield* WorkflowEngine.WorkflowEngine
		const dispatch = Effect.gen(function* () {
			const batch = yield* store.pending(
				Arr.filter(yield* workflows.names, (name) => HashMap.has(hosted, name)),
			)
			yield* Effect.forEach(
				batch,
				(message) =>
					Effect.gen(function* () {
						const key = {
							namespace: message.namespace,
							id: yield* Schema.decodeEffect(Execution.Id)(message.executionId),
						}
						const execution = yield* store.load(key)
						const contribution = HashMap.get(hosted, execution.workflow)
						// A command for a workflow with no access rules stays in the outbox.
						if (
							Option.isNone(contribution) ||
							Option.isNone(yield* workflows.get(execution.workflow))
						)
							return
						const send = Engine.transport(contribution.value.workflow)
						const command = yield* store.command(
							key.namespace,
							message.commandId,
						)
						if (Option.isNone(command))
							return yield* Execution.NotFound.make({ id: key.id })
						switch (command.value.kind) {
							case "start":
								yield* send.start(key)
								break
							case "cancel":
								if (command.value.cancelEpoch === null)
									return yield* Execution.Conflict.make({ id: key.id })
								yield* send.cancel(key, command.value.cancelEpoch)
								break
							case "signal":
								const signal = yield* Schema.decodeUnknownEffect(
									Schema.Union([
										Schema.Struct({
											kind: Schema.Literal("decision"),
											decisionId: Execution.DecisionId,
										}),
										Schema.Struct({
											kind: Schema.Literal("notify"),
											signalId: Schema.String,
										}),
									]),
								)(command.value.body)
								yield* send.signal(
									key,
									signal.kind === "decision"
										? signal.decisionId
										: signal.signalId,
								)
								break
							default:
								return yield* Execution.Conflict.make({ id: key.id })
						}
						yield* store.acknowledge(key.namespace, message.commandId)
					}).pipe(
						Effect.provideService(WorkflowEngine.WorkflowEngine, engine),
						Effect.catchCause((cause) =>
							Effect.gen(function* () {
								if (Cause.hasInterruptsOnly(cause))
									return yield* Effect.failCause(
										Cause.fromReasons<never>(
											Arr.filter(cause.reasons, Cause.isInterruptReason),
										),
									)
								yield* store.defer(message.namespace, message.commandId)
								yield* errors.record(cause, "unavailable")
							}),
						),
					),
				{ concurrency: 8, discard: true },
			)
		})
		yield* background.repeat(dispatch, {
			schedule: Schedule.spaced("500 millis"),
			message: "Execution commands could not be sent.",
		})
	})

/** Registers each handler on the engine in context. The scope owns the registrations. */
const host = (hosted: HashMap.HashMap<string, Contribution>) =>
	Effect.gen(function* () {
		const scope = yield* Effect.scope
		yield* Effect.forEach(
			HashMap.values(hosted),
			(contribution) =>
				Layer.buildWithScope(
					contribution.workflow.toLayer(contribution.run),
					scope,
				),
			{ discard: true },
		)
	})

/**
 * Tests: hosts the handlers of every workflow that is in `Workflows` now, on
 * the engine it is given. It does not seal and runs no outbox.
 */
export const layerHandlers = Layer.effectDiscard(
	Effect.gen(function* () {
		const workflows = yield* Workflows
		yield* host(yield* workflows.current)
	}),
)

/**
 * Tests: hosts every workflow on the engine it is given, such as
 * `WorkflowEngine.layerMemory`, and sends the commands of the outbox to it.
 */
export const layerLocal = Layer.effectDiscard(
	Effect.gen(function* () {
		const workflows = yield* Workflows
		const hosted = yield* workflows.seal
		yield* workflows.hold(HashMap.keys(hosted))
		yield* host(hosted)
		yield* outbox(hosted)
	}),
)

/**
 * One engine generation for these workflows, in the current scope. The
 * caller holds the workflows first, so the hold ends last: after Sharding has
 * stopped every run of them.
 */
const generation = (hosted: HashMap.HashMap<string, Contribution>) =>
	Effect.gen(function* () {
		const current = yield* EngineRpc
		const config = yield* ShardingConfig.ShardingConfig
		const scope = yield* Effect.scope
		// A node that lacks a workflow keeps its messages waiting. It never saves a "not registered" defect.
		const context = yield* Layer.buildWithScope(
			Engine.layer.pipe(
				Layer.provide(
					Layer.succeed(ShardingConfig.ShardingConfig, {
						...config,
						entityRegistrationTimeout: Duration.infinity,
					}),
				),
			),
			scope,
		)
		yield* Effect.provideContext(
			Effect.gen(function* () {
				yield* host(hosted)
				yield* outbox(hosted)
				const rpc = yield* HttpRunner.toHttpEffect.pipe(
					Effect.provideService(
						RpcSerialization.RpcSerialization,
						RpcSerialization.ndjson,
					),
				)
				yield* Effect.acquireRelease(Ref.set(current, Option.some(rpc)), () =>
					Ref.set(current, Option.none()),
				)
			}),
			context,
		)
	})

/**
 * One engine generation for the life of the layer. Build it after every
 * workflow is in `Workflows`. It closes before them.
 */
export const layer = Layer.effectDiscard(
	Effect.gen(function* () {
		const workflows = yield* Workflows
		const hosted = yield* workflows.seal
		// The hold comes first, so it ends last: after Sharding has stopped every run of these workflows.
		yield* workflows.hold(HashMap.keys(hosted))
		yield* generation(hosted)
	}),
)

/** After the plugins settle, the swap waits this long and checks again before it opens a generation. */
export const swapDelay = Duration.seconds(1)

/** How a failed open tries again: fast at first, then every 30 seconds. */
const openRetry = Schedule.min([
	Schedule.exponential("1 second"),
	Schedule.spaced("30 seconds"),
])

/** The same names, each with the same contribution object. */
const sameSet = (
	left: HashMap.HashMap<string, Contribution>,
	right: HashMap.HashMap<string, Contribution>,
) =>
	HashMap.size(left) === HashMap.size(right) &&
	Arr.every(Arr.fromIterable(left), ([name, contribution]) =>
		Option.exists(HashMap.get(right, name), (other) => other === contribution),
	)

/** The open generation hosts a name that the target lost, or a handler that changed. */
const loses = (
	hosted: HashMap.HashMap<string, Contribution>,
	target: HashMap.HashMap<string, Contribution>,
) =>
	Arr.some(
		Arr.fromIterable(hosted),
		([name, contribution]) =>
			!Option.exists(
				HashMap.get(target, name),
				(other) => other === contribution,
			),
	)

export interface SwapOptions<E, R> {
	/** The workflows that are in now, followed by each change. */
	readonly changes: Stream.Stream<HashMap.HashMap<string, Contribution>>
	readonly current: Effect.Effect<HashMap.HashMap<string, Contribution>>
	/** Opens one generation in the scope it gets, and gives the workflows it hosts. */
	readonly open: Effect.Effect<
		HashMap.HashMap<string, Contribution>,
		E,
		R | Scope.Scope
	>
	/** Ends when the plugins have settled. */
	readonly stable: Effect.Effect<void>
	readonly delay: Duration.Input
	/** Keeps the failure of a later open. The swap tries the open again. */
	readonly failed: (cause: Cause.Cause<unknown>) => Effect.Effect<void>
}

/**
 * Keeps at most one generation open, for the workflows that are in now.
 *
 * - When the open generation loses a workflow, or a workflow gets a new
 *   handler, the generation closes at once. The removal waits for this close.
 * - After a change, the swap waits until the plugins settle, then `delay`,
 *   then until they settle again. A new loss in this time closes the
 *   generation and starts the wait again.
 * - Then it closes the open generation and opens the next one. Generation N
 *   always closes before generation N + 1 opens.
 *
 * The first open happens at once. Its failure is the failure of the swap. A
 * later open that fails goes to `failed` and is tried again.
 */
export const swap = <E, R>(
	options: SwapOptions<E, R>,
): Effect.Effect<void, E, R | Scope.Scope> =>
	Effect.gen(function* () {
		const open = yield* Ref.make(
			Option.none<{
				readonly hosted: HashMap.HashMap<string, Contribution>
				readonly scope: Scope.Closeable
			}>(),
		)
		const close = Effect.uninterruptible(
			Effect.flatMap(
				Ref.getAndSet(open, Option.none()),
				Option.match({
					onNone: () => Effect.void,
					onSome: (generation) => Scope.close(generation.scope, Exit.void),
				}),
			),
		)
		// Added before the loop starts, so it runs after the loop stops.
		yield* Effect.addFinalizer(() => close)
		/** The scope is in `open` before the build starts, so `close` always finds it. */
		const next = Effect.uninterruptibleMask((restore) =>
			Effect.gen(function* () {
				if (HashMap.isEmpty(yield* options.current)) return
				const scope = yield* Scope.make()
				yield* Ref.set(open, Option.some({ hosted: HashMap.empty(), scope }))
				const hosted = yield* restore(options.open).pipe(
					Scope.provide(scope),
					Effect.onError(() => close),
				)
				yield* Ref.set(open, Option.some({ hosted, scope }))
			}),
		)
		const lost = (target: HashMap.HashMap<string, Contribution>) =>
			Effect.map(Ref.get(open), (current) =>
				Option.exists(current, (generation) =>
					loses(generation.hosted, target),
				),
			)
		/** Ends at the next change that the open generation loses. */
		const loss = options.changes.pipe(
			Stream.filterEffect(lost),
			Stream.runHead,
			Effect.asVoid,
		)
		const settled = options.stable.pipe(
			Effect.andThen(Effect.sleep(options.delay)),
			Effect.andThen(options.stable),
		)
		/** Waits until the plugins settle with no loss in between. Each loss closes at once. */
		const quiet: Effect.Effect<void> = Effect.raceFirst(
			Effect.as(settled, true),
			Effect.as(loss, false),
		).pipe(
			Effect.flatMap((done) =>
				done ? Effect.void : Effect.andThen(close, quiet),
			),
		)
		const step = (target: HashMap.HashMap<string, Contribution>) =>
			Effect.gen(function* () {
				if (yield* lost(target)) yield* close
				yield* quiet
				const wanted = yield* options.current
				const current = yield* Ref.get(open)
				if (
					Option.exists(current, (generation) =>
						sameSet(generation.hosted, wanted),
					)
				)
					return
				yield* close
				yield* next.pipe(
					Effect.tapCause((cause) =>
						Cause.hasInterruptsOnly(cause)
							? Effect.void
							: options.failed(cause),
					),
					Effect.retry(openRetry),
				)
			})
		yield* next
		yield* options.changes.pipe(
			Stream.buffer({ capacity: 1, strategy: "sliding" }),
			Stream.runForEach(step),
			Effect.forkScoped,
		)
	})

export interface RunOptions {
	/** Ends when the plugins have settled. */
	readonly stable: Effect.Effect<void>
}

/**
 * Engine generations that follow the workflows in `Workflows`, for the life
 * of the scope. A plugin may add and remove workflows at any time. See
 * `swap` for the rules. Generation 1 is open when this returns.
 */
export const run = (options: RunOptions) =>
	Effect.gen(function* () {
		const workflows = yield* Workflows
		const report = yield* Report.make
		yield* swap({
			changes: workflows.changes,
			current: workflows.current,
			open: Effect.tap(workflows.acquire, generation),
			stable: options.stable,
			delay: swapDelay,
			failed: (cause) =>
				report("An engine generation could not open.", cause).pipe(
					Effect.asVoid,
				),
		})
	})
