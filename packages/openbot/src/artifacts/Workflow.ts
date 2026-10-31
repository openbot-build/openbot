import { Effect, Layer } from "effect"
import * as Engine from "../execution/Engine.ts"
import * as Program from "../execution/Program.ts"
import { Artifacts, workflowName } from "./Artifacts.ts"

export const workflow = Engine.define(workflowName)

/** The shared engine owns restart, cancellation, and resource release. */
export const layer = Layer.unwrap(
	Effect.gen(function* () {
		const artifacts = yield* Artifacts
		const registry = yield* Engine.Registry
		const run = yield* Program.make
		return workflow
			.toLayer((key) => run(key, artifacts.perform))
			.pipe(
				Layer.provideMerge(
					Layer.effectDiscard(registry.register(workflow, artifacts.authorize)),
				),
			)
	}),
)
