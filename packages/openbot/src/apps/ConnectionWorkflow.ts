import { App } from "@openbot-build/protocol"
import { Effect, Layer, Schema } from "effect"
import { Calls } from "../execution/Calls.ts"
import * as Engine from "../execution/Engine.ts"
import * as Program from "../execution/Program.ts"
import { Store, type Fence } from "../execution/Store.ts"
import {
	ConnectionCommands,
	preparedCodec,
	workflowName,
} from "./ConnectionCommands.ts"
import { Lifecycle } from "./Lifecycle.ts"

export const workflow = Engine.define(workflowName)
export const make = Effect.gen(function* () {
	const commands = yield* ConnectionCommands
	const runtime = yield* Lifecycle
	const active = yield* App.ConnectionScopes
	const calls = yield* Calls
	const store = yield* Store
	const run = yield* Program.make
	const work = (fence: Fence) =>
		Effect.gen(function* () {
			const { saved, input } = yield* commands.load(fence)
			const check = commands
				.authorize(fence, saved.identity.actor, "advance")
				.pipe(Effect.andThen(store.guard(fence)), Effect.asVoid)
			const result = yield* calls.invoke(
				fence,
				yield* store.readAttempt(fence, "prepare", {
					connectionId: saved.record.resource.id,
				}),
				() =>
					runtime
						.prepare(input, fence.id, check)
						.pipe(
							Effect.timeout("2 minutes"),
							Effect.flatMap(Schema.encodeEffect(preparedCodec)),
						),
			)
			if (result._tag === "Unknown") return
			yield* check
			yield* active.close(input.connection.connection)
			yield* commands.commit(
				fence,
				yield* Schema.decodeEffect(preparedCodec)(result.result),
				result.callId,
			)
		})
	return {
		execute: (key: Parameters<typeof run>[0]) =>
			run(key, work, commands.finish),
		authorize: commands.authorize,
	}
})
export const layer = Layer.unwrap(
	Effect.gen(function* () {
		const program = yield* make
		const registry = yield* Engine.Registry
		return workflow
			.toLayer(program.execute)
			.pipe(
				Layer.provideMerge(
					Layer.effectDiscard(registry.register(workflow, program.authorize)),
				),
			)
	}),
)
