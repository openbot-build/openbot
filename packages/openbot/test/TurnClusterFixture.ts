import { Bots } from "../src/bots/Bots.ts"
import { LiveConnections } from "../src/chats/live/LiveConnections.ts"
import { ReviewTools } from "../src/capabilities/ReviewTools.ts"
import { Billing } from "../src/billing/Billing.ts"
import { PgClient } from "@effect/sql-pg"
import {
	Array as Arr,
	Config,
	Context,
	Effect,
	Layer,
	Stream,
	Option,
} from "effect"
import { LanguageModel, Response } from "effect/ai"
import * as Store from "../src/execution/Store.ts"
import * as Runner from "../src/execution/Runner.ts"
import * as Observation from "../src/execution/Observation.ts"
import * as InputCommands from "../src/chats/InputCommands.ts"
import * as ToolCommands from "../src/chats/ToolCommands.ts"
import * as ToolControls from "../src/chats/ToolControls.ts"
import * as TurnTools from "../src/chats/TurnTools.ts"
import * as ToolSteps from "../src/chats/ToolSteps.ts"
import * as TurnSession from "../src/chats/TurnSession.ts"
import * as TurnWorkflow from "../src/chats/TurnWorkflow.ts"
import * as ExecutionFeatures from "../src/chats/ExecutionFeatures.ts"
import * as HostTools from "../src/chats/HostTools.ts"
import { TurnAccess } from "../src/chats/TurnAccess.ts"
import { ModelRegistry } from "../src/models/ModelRegistry.ts"

/** Kill the first owner after its model result, before its Chat checkpoint. */
export const layer = Layer.unwrap(
	Effect.gen(function* () {
		const runner = yield* Config.Int("TEST_RUNNER_ID")
		const sql = yield* PgClient.PgClient
		const store = yield* Store.Store
		const model = yield* LanguageModel.make({
			generateText: () => Effect.die("This test uses a stream."),
			streamText: () =>
				Stream.fromEffect(
					sql`insert into execution_test_steps (execution_id, step, count, runner)
			values ('turn-cluster', 'model', 1, ${runner})
			on conflict (execution_id, step) do update set count = execution_test_steps.count + 1`.pipe(
						Effect.orDie,
					),
				).pipe(
					Stream.flatMap(() =>
						Stream.make(
							Response.makePart("text-start", { id: "text" }),
							Response.makePart("text-delta", {
								id: "text",
								delta: "saved answer",
							}),
							Response.makePart("text-end", { id: "text" }),
							Response.makePart("finish", {
								reason: "stop",
								usage: {
									inputTokens: {
										total: 1,
										uncached: 1,
										cacheRead: 0,
										cacheWrite: 0,
									},
									outputTokens: { total: 1, text: 1, reasoning: 0 },
								},
							}),
						),
					),
				),
		})
		const paused = Store.Store.of({
			...store,
			commit: (fence, change, writes) =>
				Effect.gen(function* () {
					if (
						fence.namespace === "turn-cluster" &&
						typeof change.events !== "function" &&
						Arr.some(
							change.events ?? [],
							(event) => event._tag === "Checkpoint",
						) &&
						Arr.some(
							yield* store.calls(fence),
							(call) => call.status === "completed",
						)
					) {
						// This marker must commit outside the Chat transaction that will be killed.
						const claimed =
							yield* sql`insert into execution_test_steps (execution_id, step, count, runner)
				values (${fence.id}, 'checkpoint', 1, ${runner}) on conflict do nothing returning runner`.pipe(
								Effect.updateContext((context: Context.Context<never>) =>
									Context.omit(sql.transactionService)(context),
								),
								Effect.orDie,
							)
						if (claimed.length > 0) return yield* Effect.never
					}
					return yield* store.commit(fence, change, writes)
				}),
		})
		return TurnWorkflow.layer.pipe(
			Layer.provide(Layer.mergeAll(TurnSession.layer, Runner.layer)),
			Layer.provide(Layer.mergeAll(TurnTools.layer, ToolControls.layer)),
			Layer.provide(
				Layer.mergeAll(
					ToolCommands.layer,
					InputCommands.layer,
					Observation.layer,
					ToolSteps.layer,
				),
			),
			Layer.provide(Layer.succeed(Store.Store, paused)),
			Layer.provide(
				Layer.mergeAll(
					ExecutionFeatures.none,
					Layer.mock(LiveConnections, {}),
					Layer.mock(ReviewTools, {
						register: () => Effect.die("This test has no review Chat."),
					}),
					HostTools.none,
					Layer.mock(Bots, {}),
					Layer.mock(Billing, {
						releaseExecution: () => Effect.succeed(true),
						record: () => Effect.void,
						unknown: () => Effect.void,
					}),
					Layer.mock(TurnAccess, {
						admit: () => Effect.void,
						model: () => Effect.void,
						authorize: () => Effect.void,
						input: () => Effect.void,
						notice: () => Effect.succeed(true),
					}),
					Layer.mock(ModelRegistry, {
						defaultModel: Option.none(),
						catalog: () => Effect.succeed({ providers: [], models: [] }),
						resolve: () => Effect.succeed(model),
					}),
				),
			),
		)
	}),
)
