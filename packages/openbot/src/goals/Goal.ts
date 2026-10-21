import { Agent, Session, Plugin } from "@openbot-build/core"
import { Data, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"

export class Definition extends Schema.TaggedClass<Definition>()(
	"Goal.Definition",
	{
		objective: Schema.String,
		tokenBudget: Schema.optionalKey(Schema.Finite),
	},
) {}

/** Business value that the Session owns. The execution context gives the current identity. */
export const Value = Schema.Struct({
	definition: Definition,
	status: Schema.Literals(["active", "paused"]),
	usedTokens: Schema.Finite,
})

export type Value = typeof Value.Type

export const ValueCodec = Schema.toCodecJson(Value)

/** A view of the result at runtime. The host gives the current branch binding. */
export class State extends Schema.TaggedClass<State>()("Goal.State", {
	session: Session.Id,
	...Value.fields,
}) {}

/** A host uses this when it builds its schema. It does not install storage or change middleware. */
export const storeKey = "@openbot-build/openbot/goals"
export const pluginId = Schema.Literal(storeKey)
	.pipe(Schema.brand("@openbot-build/core/PluginId"))
	.make(storeKey)

export const store = {
	scope: "session",
	schema: ValueCodec,
} satisfies Plugin.StoreDefinition<typeof ValueCodec>

export class GoalError extends Data.TaggedError("GoalError")<{
	readonly reason:
		| "session-not-found"
		| "goal-not-found"
		| "invalid-goal"
		| "state-conflict"
		| "storage-failed"
	readonly message: string
}> {}

const emptyParameters = Schema.Struct({})

const definitionParameters = Schema.Struct({
	objective: Schema.String,
	tokenBudget: Schema.optional(Schema.Finite),
})

const goalErrorSchema = Schema.instanceOf(GoalError)

export const toolkit = Toolkit.make(
	Tool.make("SetGoal", {
		dependencies: [Agent.Context],
		description: "Set a persistent goal for the current session.",
		parameters: definitionParameters,
		success: State,
		failure: goalErrorSchema,
		failureMode: "error",
	}),
	Tool.make("GetGoal", {
		dependencies: [Agent.Context],
		description:
			"Get the current goal for the current session, or null if none is set.",
		parameters: emptyParameters,
		success: Schema.NullOr(State),
		failure: goalErrorSchema,
		failureMode: "error",
	}),
	Tool.make("UpdateGoal", {
		dependencies: [Agent.Context],
		description:
			"Replace the objective and the optional token budget of the goal for the current session.",
		parameters: definitionParameters,
		success: State,
		failure: goalErrorSchema,
		failureMode: "error",
	}),
	Tool.make("PauseGoal", {
		dependencies: [Agent.Context],
		description: "Pause the persistent goal for the current session.",
		parameters: emptyParameters,
		success: State,
		failure: goalErrorSchema,
		failureMode: "error",
	}),
	Tool.make("ResumeGoal", {
		dependencies: [Agent.Context],
		description: "Resume the paused persistent goal for the current session.",
		parameters: emptyParameters,
		success: State,
		failure: goalErrorSchema,
		failureMode: "error",
	}),
	Tool.make("ClearGoal", {
		dependencies: [Agent.Context],
		description:
			"Clear the persistent goal for the current session and return null.",
		parameters: emptyParameters,
		success: Schema.Null,
		failure: goalErrorSchema,
		failureMode: "error",
	}),
)
