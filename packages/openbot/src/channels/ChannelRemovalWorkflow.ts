import { Effect, Layer } from "effect"
import * as Engine from "../execution/Engine.ts"
import * as Program from "../execution/Program.ts"
import { ChannelRemoval, workflowName } from "./ChannelRemoval.ts"

export const workflow = Engine.define(workflowName)
export const layer = Layer.unwrap(
	Effect.gen(function* () {
		const commands = yield* ChannelRemoval
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
