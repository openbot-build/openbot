import { Effect, Layer } from "effect"
import * as Engine from "../execution/Engine.ts"
import * as Program from "../execution/Program.ts"
import * as ChatControl from "./ChatControl.ts"

export const workflow = Engine.define(ChatControl.workflowName)
export const layer = Layer.unwrap(
	Effect.gen(function* () {
		const commands = yield* ChatControl.make
		const registry = yield* Engine.Registry
		const run = yield* Program.make
		return workflow
			.toLayer((key) => run(key, commands.work, commands.finish))
			.pipe(
				Layer.provideMerge(
					Layer.effectDiscard(registry.register(workflow, commands.authorize)),
				),
			)
	}),
)
