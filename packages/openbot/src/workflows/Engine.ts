import { NodeCrypto } from "@effect/platform-node"
import { Cause, Duration, Effect, Layer, Predicate, Schema } from "effect"
import {
	ClusterWorkflowEngine,
	RunnerHealth,
	Runners,
	Sharding,
	ShardingConfig,
	SqlMessageStorage,
	SqlRunnerStorage,
} from "effect/cluster"
import { Activity, DurableClock, DurableDeferred } from "effect/workflow"
import { clusterPrefix } from "../database/Migrations.ts"
import {
	changed,
	type NodePayload,
	NodeWorkflow,
	RunWorkflow,
	turnEnded,
} from "./Execution.ts"
import {
	Next,
	type Payload,
	Plan,
	ReplayCheck,
	type Start,
	TaskFailed,
	Tasks,
	type TurnKind,
} from "./Tasks.ts"

/**
 * The durable workflow engine of one OpenBot process. Its messages and replies live in
 * Postgres, so a Run goes on after a restart. `openbot-migrate` makes its tables, so this
 * layer runs no DDL. One process owns all shards. The shard locks are in Postgres too.
 */
export const layerEngine = ClusterWorkflowEngine.layer.pipe(
	Layer.provideMerge(
		Sharding.layer.pipe(
			Layer.provideMerge(Runners.layerNoop),
			Layer.provideMerge(
				SqlMessageStorage.layerStorage({ prefix: clusterPrefix }),
			),
			Layer.provide([
				SqlRunnerStorage.layerStorage({ prefix: clusterPrefix }),
				RunnerHealth.layerNoop,
			]),
			Layer.provide(ShardingConfig.layer()),
		),
	),
	Layer.provide(NodeCrypto.layer),
)

/** One task of a durable execution. Its result is kept, so it runs again only when it did not finish. */
const activity = <A, I>(
	name: string,
	success: Schema.Codec<A, I>,
	execute: Effect.Effect<A, TaskFailed>,
) =>
	Activity.make({ name, success, error: TaskFailed, execute }).pipe(
		Activity.retry({ times: 2 }),
	)

/**
 * The scheduler of a Run, as a durable workflow. Each round starts the nodes that can start,
 * and then waits until something changes: a node ends, a child Run ends, or the Run moves to
 * another revision. Nothing runs in memory while it waits.
 */
const layerRun = RunWorkflow.toLayer(
	Effect.fnUntraced(function* (payload: Payload) {
		const tasks = yield* Tasks
		yield* Effect.gen(function* () {
			if (!(yield* activity("prepare", Schema.Boolean, tasks.prepare(payload))))
				return
			for (let round = 0; ; round++) {
				const done = yield* activity(
					"tick/" + round,
					Schema.Boolean,
					tasks.tick(payload, round),
				)
				if (done) break
				yield* DurableDeferred.await(changed(round))
			}
			yield* activity("finish", Schema.Void, tasks.finish(payload))
		}).pipe(
			Effect.catchTag("TaskFailed", (failure) =>
				activity(
					"abort",
					Schema.Void,
					tasks.abort(payload, failure.message),
				).pipe(Effect.orElseSucceed(() => undefined)),
			),
		)
	}),
)

/**
 * One start of one node, as a durable workflow. A task that starts a Turn saves a token,
 * and the execution waits on a durable deferred until the Turn ends.
 */
const layerNode = NodeWorkflow.toLayer(
	Effect.fnUntraced(function* (payload: NodePayload) {
		const tasks = yield* Tasks
		// Task names start with the node and its attempt. The Run keeps its Turns by these names.
		const prefix = payload.node + "/" + payload.attempt + "/"
		/** Starts the Turn of a task and waits until it ends. */
		const turn = (task: string, start: Start) =>
			Effect.gen(function* () {
				const deferred = turnEnded(prefix + task)
				const token = yield* DurableDeferred.token(deferred)
				const ended = yield* activity(
					task + "/start",
					Schema.Boolean,
					tasks.start(payload, prefix + task, start, token),
				)
				if (!ended) yield* DurableDeferred.await(deferred)
			})
		/** After a `Task` node: the end, or a Turn that checks it. */
		const next = (after: Next) =>
			Effect.gen(function* () {
				if (after._tag === "Done") return
				yield* turn("verify", after.start)
				yield* activity(
					"verify/collect",
					Schema.Void,
					tasks.collectTaskCheck(payload, prefix + "verify"),
				)
			})
		const collectors = {
			task: (task: string) =>
				activity(
					task + "/collect",
					Next,
					tasks.collectTask(payload, prefix + task, "live", []),
				).pipe(Effect.flatMap(next)),
			check: (task: string) =>
				activity(
					task + "/collect",
					Schema.Void,
					tasks.collectCheck(payload, prefix + task),
				),
			plan: (task: string) =>
				activity(
					task + "/collect",
					Schema.Void,
					tasks.collectPlan(payload, prefix + task),
				),
			accept: (task: string) =>
				activity(
					task + "/collect",
					Schema.Void,
					tasks.collectAccept(payload, prefix + task),
				),
			budget: (task: string) =>
				activity(
					task + "/collect",
					Schema.Void,
					tasks.collectBudget(payload, prefix + task),
				),
		} satisfies Record<
			TurnKind,
			(task: string) => Effect.Effect<void, TaskFailed, any>
		>
		yield* Effect.gen(function* () {
			const plan = yield* activity("plan", Plan, tasks.plan(payload))
			switch (plan._tag) {
				case "Done":
					return
				case "Call":
					yield* turn("call", plan.start)
					return yield* activity(
						"call/collect",
						Schema.Void,
						tasks.collectCall(payload, prefix + "call"),
					)
				case "Sleep":
					yield* DurableClock.sleep({
						name: "sleep",
						duration: Duration.seconds(plan.seconds),
					})
					return yield* activity("slept", Schema.Void, tasks.slept(payload))
				case "Child":
					return yield* activity(
						"child",
						Schema.Void,
						tasks.startChild(payload),
					)
				case "Turn":
					yield* turn(plan.kind, plan.start)
					return yield* collectors[plan.kind](plan.kind)
				case "Replay": {
					for (const [call, recorded] of plan.calls.entries()) {
						const task = "replay/" + call
						yield* turn(task, {
							_tag: "Action",
							agent: plan.agent,
							tool: recorded.tool,
							arguments: recorded.arguments,
						})
						const check = yield* activity(
							task + "/check",
							ReplayCheck,
							tasks.checkReplay(payload, prefix + task, call, plan.calls),
						)
						if (check._tag === "Handoff") {
							yield* turn("handoff", {
								_tag: "Message",
								agent: plan.agent,
								text: check.text,
							})
							const after = yield* activity(
								"handoff/collect",
								Next,
								tasks.collectTask(
									payload,
									prefix + "handoff",
									"handed_off",
									plan.calls.slice(0, call),
								),
							)
							return yield* next(after)
						}
					}
					const after = yield* activity(
						"replayed",
						Next,
						tasks.replayed(payload, plan.calls.length),
					)
					return yield* next(after)
				}
				case "Wait": {
					for (let attempt = 0; attempt < plan.attempts; attempt++) {
						const task = "check/" + attempt
						const last = attempt === plan.attempts - 1
						yield* turn(task, plan.start)
						const passed = yield* activity(
							task + "/collect",
							Schema.Boolean,
							tasks.collectWait(payload, prefix + task, last),
						)
						if (passed || last) return
						yield* DurableClock.sleep({
							name: "sleep/" + attempt,
							duration: Duration.seconds(plan.intervalSeconds),
						})
					}
					return
				}
			}
		}).pipe(
			// A node that cannot finish fails by itself, so the Run never waits for it forever.
			Effect.catchCause((cause) => {
				if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
				const error = Cause.squash(cause)
				const message =
					Predicate.hasProperty(error, "message") &&
					typeof error.message === "string"
						? error.message
						: "The node could not finish."
				return activity(
					"crash",
					Schema.Void,
					tasks.crash(payload, message),
				).pipe(Effect.orElseSucceed(() => undefined))
			}),
		)
	}),
)

export const layer = Layer.mergeAll(layerRun, layerNode)
