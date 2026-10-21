import { NodeCrypto } from "@effect/platform-node"
import { Duration, Effect, Layer, Schema } from "effect"
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
import { RunWorkflow, turnEnded } from "./Execution.ts"
import {
	type Payload,
	Plan,
	ReplayCheck,
	type Start,
	TaskFailed,
	Tasks,
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

/**
 * The steps of a Run, as a durable workflow. Each task is an activity, so its result is kept.
 * A task that starts a Turn saves a token, and the execution waits on a durable deferred
 * until the Turn ends. Then nothing runs in memory while the Agent works or waits for approval.
 */
export const layer = RunWorkflow.toLayer(
	Effect.fnUntraced(function* (payload: Payload) {
		const tasks = yield* Tasks
		const activity = <A, I>(
			name: string,
			success: Schema.Codec<A, I>,
			execute: Effect.Effect<A, TaskFailed>,
		) =>
			Activity.make({ name, success, error: TaskFailed, execute }).pipe(
				Activity.retry({ times: 2 }),
			)
		/** Starts the Turn of a task and waits until it ends. */
		const turn = (task: string, index: number, start: Start) =>
			Effect.gen(function* () {
				const deferred = turnEnded(task)
				const token = yield* DurableDeferred.token(deferred)
				const ended = yield* activity(
					task + "/start",
					Schema.Boolean,
					tasks.start(payload, index, task, start, token),
				)
				if (!ended) yield* DurableDeferred.await(deferred)
			})
		const step = (index: number) =>
			Effect.gen(function* () {
				const name = "s" + index
				const plan = yield* activity(
					name + "/plan",
					Plan,
					tasks.plan(payload, index),
				)
				switch (plan._tag) {
					case "Done":
						return plan.passed
					case "Call": {
						const task = name + "/call"
						yield* turn(task, index, plan.start)
						return yield* activity(
							task + "/collect",
							Schema.Boolean,
							tasks.collectCall(payload, index, task),
						)
					}
					case "Turn": {
						const task = name + "/live"
						yield* turn(task, index, plan.start)
						return yield* activity(
							task + "/collect",
							Schema.Boolean,
							tasks.collect(payload, index, task, "live", []),
						)
					}
					case "Replay": {
						for (const [call, recorded] of plan.calls.entries()) {
							const task = name + "/replay/" + call
							yield* turn(task, index, {
								_tag: "Action",
								agent: plan.agent,
								tool: recorded.tool,
								arguments: recorded.arguments,
							})
							const check = yield* activity(
								task + "/check",
								ReplayCheck,
								tasks.checkReplay(payload, index, task, call, plan.calls),
							)
							if (check._tag === "Handoff") {
								const handoff = name + "/handoff"
								yield* turn(handoff, index, {
									_tag: "Message",
									agent: plan.agent,
									text: check.text,
								})
								return yield* activity(
									handoff + "/collect",
									Schema.Boolean,
									tasks.collect(
										payload,
										index,
										handoff,
										"handed_off",
										plan.calls.slice(0, call),
									),
								)
							}
						}
						return yield* activity(
							name + "/replayed",
							Schema.Boolean,
							tasks.replayed(payload, index, plan.calls.length),
						)
					}
					case "Wait": {
						for (let attempt = 0; attempt < plan.attempts; attempt++) {
							const task = name + "/check/" + attempt
							const last = attempt === plan.attempts - 1
							yield* turn(task, index, plan.start)
							const passed = yield* activity(
								task + "/collect",
								Schema.Boolean,
								tasks.collectWait(payload, index, task, last),
							)
							if (passed) return true
							if (last) return false
							yield* DurableClock.sleep({
								name: name + "/sleep/" + attempt,
								duration: Duration.seconds(plan.intervalSeconds),
							})
						}
						return false
					}
				}
			})
		yield* Effect.gen(function* () {
			const count = yield* activity(
				"prepare",
				Schema.Int,
				tasks.prepare(payload),
			)
			if (count === 0) return
			for (let index = 0; index < count; index++) {
				if (!(yield* step(index))) {
					yield* activity("skip", Schema.Void, tasks.skip(payload, index + 1))
					break
				}
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
