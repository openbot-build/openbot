import { Effect, Layer, Stream } from "effect"
import * as ChannelSend from "./ChannelSend.ts"
import * as Engine from "../server-execution/execution/Engine.ts"
import { Policy, Workflows } from "../server-execution/execution/Workflows.ts"
import * as Program from "../server-execution/execution/Program.ts"
import { Observation } from "../server-execution/execution/Observation.ts"
import { type Fence } from "../server-execution/execution/Store.ts"
import { ChannelConfig, workflowName } from "./ChannelConfig.ts"
import { ChannelRegistry } from "./ChannelRegistry.ts"

export const workflow = Engine.define(workflowName)
/** Adds the workflow and its access rules. When the scope closes, they go. */
export const contribute = Effect.gen(function* () {
	const commands = yield* ChannelConfig
	const workflows = yield* Workflows
	const channels = yield* ChannelRegistry
	const send = yield* ChannelSend.make
	const observation = yield* Observation
	const run = yield* Program.make
	const work = (fence: Fence) =>
		Effect.gen(function* () {
			const saved = yield* commands.load(fence)
			if (saved.input.predecessor !== null)
				yield* observation
					.observe(saved.input.predecessor, 0)
					.pipe(Stream.runDrain)
			yield* commands.authorize(
				fence,
				saved.execution.identity.actor,
				"advance",
			)
			const result = yield* Effect.scoped(
				Effect.gen(function* () {
					const channel = yield* channels.build(
						saved.input.channel.id,
						saved.input.credentials,
					)
					const input = {
						channelId: saved.input.channel.id,
						version: saved.input.channel.version,
						webhookUrl: saved.input.webhookUrl,
					}
					return yield* send.register(fence, channel, input)
				}),
			)
			if (result) yield* commands.finish(fence, { status: "completed" })
		})
	yield* workflows.contribute({
		workflow,
		plugin: "channels",
		journal: 1,
		run: (key) => run(key, work, commands.finish),
		policy: Policy.Public({ authorize: commands.authorize }),
	})
})

export const layer = Layer.effectDiscard(contribute)
