import type * as Admission from "./Admission.ts"
import {
	type Caller,
	type ServiceCaller,
	type ServiceId,
	Execution,
} from "@openbot-build/domain"
import {
	Array as Arr,
	Cause,
	Context,
	Effect,
	HashMap,
	Layer,
	Option,
	Ref,
	Schedule,
	Schema,
} from "effect"
import {
	ClusterWorkflowEngine,
	HttpRunner,
	RunnerHealth,
	Runners,
	Sharding,
	SqlMessageStorage,
	SqlRunnerStorage,
} from "effect/cluster"
import { HttpRouter } from "effect/http"
import { RpcSerialization } from "effect/rpc"
import { DurableDeferred, Workflow, WorkflowEngine } from "effect/workflow"
import { Records } from "../errors/Records.ts"
import * as Background from "./Background.ts"
import { Store, type Key } from "./Store.ts"
import * as PrivateRpc from "../transport/PrivateRpc.ts"

export const path = "/internal/executions/rpc"

const protocol = HttpRunner.layerClientProtocolHttp({ path }).pipe(
	Layer.provide(PrivateRpc.layerClient),
)
const storage = Layer.mergeAll(
	SqlMessageStorage.layerStorage({ prefix: "openbot_cluster" }),
	SqlRunnerStorage.layerStorage({ prefix: "openbot_cluster" }),
)
const runners = Runners.layerRpc.pipe(
	Layer.provide(protocol),
	Layer.provideMerge(storage),
)
const sharding = Sharding.layer.pipe(
	Layer.provideMerge(RunnerHealth.layerPing.pipe(Layer.provideMerge(runners))),
)

/** Both one-node and many-node servers use SQL storage and authenticated HTTP RPC. */
export const layer = ClusterWorkflowEngine.layer.pipe(
	Layer.provideMerge(sharding),
	Layer.provide(RpcSerialization.layerNdjson),
)

export const layerRoutes = Layer.effectDiscard(
	Effect.gen(function* () {
		const router = yield* HttpRouter.HttpRouter
		const gate = yield* PrivateRpc.make
		const rpc = yield* HttpRunner.toHttpEffect
		yield* router.add("POST", path, gate.protect(rpc))
	}),
).pipe(Layer.provide(RpcSerialization.layerNdjson))

/** Engine messages hold references. A feature opens its sealed input from Store. */
export const define = <const Name extends string>(name: Name) =>
	Workflow.make(name, {
		payload: { namespace: Schema.String, id: Execution.Id },
		success: Schema.Void,
		error: Execution.Failure,
		idempotencyKey: ({ namespace, id }) =>
			`${namespace.length}:${namespace}${id}`,
	})

/** Signals hold no data. The workflow reads sealed records. Keep their stored names stable. */
export const signal = (id: string) => DurableDeferred.make(`decision:${id}`)

export const cancelSignal = (epoch: number) =>
	DurableDeferred.make(`cancel:${epoch}`)

export type Access = "read" | "cancel" | "decide" | "advance" | "replay"
export type Authorize = (
	key: Key,
	actor: Caller,
	access: Access,
) => Effect.Effect<
	void,
	Execution.Forbidden | Execution.NotFound | Execution.StorageError
>
/** A feature can commit its own records when a public decision is accepted. */
export interface DecisionCommand {
	readonly commandKey: Execution.CommandKey
	readonly decisionId: string
	readonly answer: Execution.Answer
}
export type Decide = (
	key: Key,
	actor: Caller,
	input: DecisionCommand,
) => Effect.Effect<
	Execution.Receipt,
	| Execution.Forbidden
	| Execution.NotFound
	| Execution.Conflict
	| Execution.KeyConflict
	| Execution.StorageError
>
interface Registered {
	readonly admit?: Admission.Check
	readonly decide?: Decide

	readonly authorize: (
		key: Key,
		actor: Caller | ServiceCaller,
		access: Access,
	) => ReturnType<Authorize>
	readonly start: (key: Key) => Effect.Effect<void>
	readonly cancel: (key: Key, epoch: number) => Effect.Effect<void>
	readonly signal: (key: Key, decisionId: string) => Effect.Effect<void>
}
const makeRegistry = Effect.gen(function* () {
	const entries = yield* Ref.make(HashMap.empty<string, Registered>())
	const engine = yield* WorkflowEngine.WorkflowEngine
	const install = Effect.fn("ExecutionEngine.install")(function* (
		workflow: ReturnType<typeof define>,
		authorize: Registered["authorize"],
		decide?: Decide,
		admit?: Admission.Check,
	) {
		const run: Registered = {
			...(admit === undefined ? {} : { admit }),
			authorize,
			...(decide === undefined ? {} : { decide }),
			start: (key) =>
				workflow
					.execute(key, { discard: true, detached: true })
					.pipe(
						Effect.asVoid,
						Effect.provideService(WorkflowEngine.WorkflowEngine, engine),
					),
			// Delivery stores only a signal. The workflow owns release and the final state.
			cancel: (key, epoch) =>
				Effect.gen(function* () {
					const executionId = yield* workflow.execute(key, {
						discard: true,
						detached: true,
					})
					const signal = cancelSignal(epoch)
					yield* DurableDeferred.succeed(signal, {
						token: DurableDeferred.tokenFromExecutionId(signal, {
							workflow,
							executionId,
						}),
						value: undefined,
					})
				}).pipe(Effect.provideService(WorkflowEngine.WorkflowEngine, engine)),
			signal: (key, id) =>
				Effect.gen(function* () {
					const executionId = yield* workflow.execute(key, {
						discard: true,
						detached: true,
					})
					const named = signal(id)
					yield* DurableDeferred.succeed(named, {
						token: DurableDeferred.tokenFromExecutionId(named, {
							workflow,
							executionId,
						}),
						value: undefined,
					})
				}).pipe(Effect.provideService(WorkflowEngine.WorkflowEngine, engine)),
		}
		yield* Ref.update(entries, HashMap.set(workflow._tag, run))
	})
	/** Public callers and saved service callers have separate authorization paths. */
	const register = (
		workflow: ReturnType<typeof define>,
		authorize: Authorize,
		decide?: Decide,
		admit?: Admission.Check,
	) =>
		install(
			workflow,
			(key, actor, access) =>
				actor.kind === "service"
					? Effect.fail(Execution.Forbidden.make({}))
					: authorize(key, actor, access),
			decide,
			admit,
		)
	const registerService = (
		workflow: ReturnType<typeof define>,
		serviceId: ServiceId,
		authorize: (key: Key, access: Access) => ReturnType<Authorize>,
		admit?: Admission.Check,
		publicRead?: Authorize,
		publicDecision?: {
			readonly authorize: Authorize
			readonly decide: Decide
		},
	) =>
		install(
			workflow,
			(key, actor, access) =>
				actor.kind !== "service"
					? publicRead !== undefined && access === "read"
						? publicRead(key, actor, access)
						: publicDecision !== undefined && access === "decide"
							? publicDecision.authorize(key, actor, access)
							: Effect.fail(Execution.Forbidden.make({}))
					: actor.serviceId !== serviceId
						? Effect.fail(Execution.Forbidden.make({}))
						: authorize(key, access),
			publicDecision?.decide,
			admit,
		)
	const get = (name: string) =>
		Ref.get(entries).pipe(Effect.map(HashMap.get(name)))
	const names = Ref.get(entries).pipe(
		Effect.map((entries) => Arr.fromIterable(HashMap.keys(entries))),
	)
	return { register, registerService, get, names }
})
export class Registry extends Context.Service<
	Registry,
	Effect.Success<typeof makeRegistry>
>()("@openbot-build/openbot/execution/Engine/Registry") {}
export const layerRegistry = Layer.effect(Registry, makeRegistry)

/** No database lock is held while the engine stores a command. Redelivery is safe. */
export const layerOutbox = Layer.effectDiscard(
	Effect.gen(function* () {
		const background = yield* Background.make
		const store = yield* Store
		const registry = yield* Registry
		const errors = yield* Records
		const dispatch = Effect.gen(function* () {
			const batch = yield* store.pending(yield* registry.names)
			yield* Effect.forEach(
				batch,
				(message) =>
					Effect.gen(function* () {
						const key = {
							namespace: message.namespace,
							id: yield* Schema.decodeEffect(Execution.Id)(message.executionId),
						}
						const execution = yield* store.load(key)
						const registered = yield* registry.get(execution.workflow)
						if (Option.isNone(registered)) return
						const command = yield* store.command(
							key.namespace,
							message.commandId,
						)
						if (Option.isNone(command))
							return yield* Execution.NotFound.make({ id: key.id })
						switch (command.value.kind) {
							case "start":
								yield* registered.value.start(key)
								break
							case "cancel":
								if (command.value.cancelEpoch === null)
									return yield* Execution.Conflict.make({ id: key.id })
								yield* registered.value.cancel(key, command.value.cancelEpoch)
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
								yield* registered.value.signal(
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
	}),
)
