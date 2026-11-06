import { Effect, Layer } from "effect"
import * as Engine from "@openbot-build/server-execution/Engine"
import { Policy, Workflows } from "@openbot-build/server-execution/Workflows"
import * as Program from "@openbot-build/server-execution/Program"
import { DeveloperIndexing, workflowName } from "./DeveloperIndexing.ts"
export const workflow = Engine.define(workflowName)
/** Adds the workflow and its access rules. When the scope closes, they go. */
export const contribute = Effect.gen(function* () {
	const commands = yield* DeveloperIndexing
	const workflows = yield* Workflows
	const run = yield* Program.make
	yield* workflows.contribute({
		workflow,
		plugin: "apps",
		journal: 1,
		run: (key) => run(key, commands.work),
		policy: Policy.Public({ authorize: commands.authorize }),
	})
})

export const layer = Layer.effectDiscard(contribute)
