import { Effect, Layer } from "effect"
import { Digest } from "effect/crypto"
import * as Engine from "@openbot-build/server-execution/Engine"
import * as Program from "@openbot-build/server-execution/Program"
import { Policy, Workflows } from "@openbot-build/server-execution/Workflows"
import { Artifacts, workflowName } from "./Artifacts.ts"

export const workflow = Engine.define(workflowName)

/** Gives the workflow and its access rules to the shared engine. */
export const contribute = Effect.gen(function* () {
	const artifacts = yield* Artifacts
	const workflows = yield* Workflows
	const run = yield* Program.make
	const hashing = yield* Digest.Digest
	yield* workflows.contribute({
		workflow,
		plugin: "artifacts",
		journal: 1,
		run: (key) =>
			run(key, artifacts.perform).pipe(
				Effect.provideService(Digest.Digest, hashing),
			),
		policy: Policy.Public({ authorize: artifacts.authorize }),
	})
})
export const layer = Layer.effectDiscard(contribute)
