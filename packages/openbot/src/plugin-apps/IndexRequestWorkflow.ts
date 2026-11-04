import { Effect, Layer } from "effect"
import * as Engine from "../server-execution/execution/Engine.ts"
import * as Program from "../server-execution/execution/Program.ts"
import { DeveloperIndexing, workflowName } from "./DeveloperIndexing.ts"
export const workflow = Engine.define(workflowName)
export const layer = Layer.unwrap(
	Effect.gen(function* () {
		const commands = yield* DeveloperIndexing
		const registry = yield* Engine.Registry
		const run = yield* Program.make
		return workflow
			.toLayer((key) => run(key, commands.work))
			.pipe(
				Layer.provideMerge(
					Layer.effectDiscard(registry.register(workflow, commands.authorize)),
				),
			)
	}),
)
