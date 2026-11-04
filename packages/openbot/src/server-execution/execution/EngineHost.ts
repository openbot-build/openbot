import { Execution } from "@openbot-build/domain"
import {
	Array as Arr,
	Cause,
	Context,
	Duration,
	Effect,
	HashMap,
	Layer,
	Option,
	Ref,
	Schedule,
	Schema,
	type Scope,
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
 * One engine generation for the life of the layer. Build it after every
 * workflow is in `Workflows`. It closes before them.
 */
export const layer = Layer.effectDiscard(
	Effect.gen(function* () {
		const workflows = yield* Workflows
		const current = yield* EngineRpc
		const config = yield* ShardingConfig.ShardingConfig
		const hosted = yield* workflows.seal
		const scope = yield* Effect.scope
		// The hold comes first, so it ends last: after Sharding has stopped every run of these workflows.
		yield* workflows.hold(HashMap.keys(hosted))
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
	}),
)
