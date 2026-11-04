import { Effect, Layer, Stream } from "effect"
import * as Engine from "../server-execution/execution/Engine.ts"
import { Policy, Workflows } from "../server-execution/execution/Workflows.ts"
import * as Program from "../server-execution/execution/Program.ts"
import { Observation } from "../server-execution/execution/Observation.ts"
import { ChannelInbox, workflowName as inputName } from "./ChannelInbox.ts"
import { ChannelWatch, workflowName as watchName } from "./ChannelWatch.ts"
import { ChannelQueue, workflowName as deliveryName } from "./ChannelQueue.ts"
import * as ChannelInputWork from "./ChannelInputWork.ts"
import * as ChannelWatchWork from "./ChannelWatchWork.ts"
import * as ChannelDeliveryWork from "./ChannelDeliveryWork.ts"

export const input = Engine.define(inputName)
export const watch = Engine.define(watchName)
export const delivery = Engine.define(deliveryName)
const contributeInput = Effect.gen(function* () {
	const inbox = yield* ChannelInbox
	const work = yield* ChannelInputWork.make
	const observation = yield* Observation
	const run = yield* Program.make
	const workflows = yield* Workflows
	yield* workflows.contribute({
		workflow: input,
		plugin: "channels",
		journal: 1,
		policy: Policy.Public({ authorize: work.authorize }),
		run: (key) =>
			run(
				key,
				(fence) =>
					Effect.gen(function* () {
						const saved = yield* inbox.load(fence)
						if (saved.input.predecessor !== null)
							yield* observation
								.observe(saved.input.predecessor, 0)
								.pipe(Stream.runDrain)
						if (yield* work.handle(fence))
							yield* inbox.finish(fence, { status: "completed" })
					}),
				inbox.finish,
			),
	})
})
const contributeWatch = Effect.gen(function* () {
	const watches = yield* ChannelWatch
	const work = yield* ChannelWatchWork.make
	const run = yield* Program.make
	const workflows = yield* Workflows
	yield* workflows.contribute({
		workflow: watch,
		plugin: "channels",
		journal: 1,
		run: (key) => run(key, work.handle, watches.finish),
		policy: Policy.Public({ authorize: work.authorize }),
	})
})
const contributeDelivery = Effect.gen(function* () {
	const queue = yield* ChannelQueue
	const work = yield* ChannelDeliveryWork.make
	const run = yield* Program.make
	const workflows = yield* Workflows
	yield* workflows.contribute({
		workflow: delivery,
		plugin: "channels",
		journal: 1,
		run: (key) => run(key, work.handle, queue.finish),
		policy: Policy.Public({ authorize: work.authorize }),
	})
})
/** Adds the three Channel workflows and their access rules. */
export const contribute = Effect.all(
	[contributeInput, contributeWatch, contributeDelivery],
	{ discard: true },
)

export const layer = Layer.effectDiscard(contribute)
