import { Effect, Layer, Stream } from "effect"
import * as Engine from "../execution/Engine.ts"
import * as Program from "../execution/Program.ts"
import { Observation } from "../execution/Observation.ts"
import { ChannelInbox, workflowName as inputName } from "./ChannelInbox.ts"
import { ChannelWatch, workflowName as watchName } from "./ChannelWatch.ts"
import { ChannelQueue, workflowName as deliveryName } from "./ChannelQueue.ts"
import * as ChannelInputWork from "./ChannelInputWork.ts"
import * as ChannelWatchWork from "./ChannelWatchWork.ts"
import * as ChannelDeliveryWork from "./ChannelDeliveryWork.ts"

export const input = Engine.define(inputName)
export const watch = Engine.define(watchName)
export const delivery = Engine.define(deliveryName)
const inputLayer = Layer.unwrap(
	Effect.gen(function* () {
		const inbox = yield* ChannelInbox
		const work = yield* ChannelInputWork.make
		const observation = yield* Observation
		const run = yield* Program.make
		const registry = yield* Engine.Registry
		return input
			.toLayer((key) =>
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
			)
			.pipe(
				Layer.provideMerge(
					Layer.effectDiscard(registry.register(input, work.authorize)),
				),
			)
	}),
)
const watchLayer = Layer.unwrap(
	Effect.gen(function* () {
		const watches = yield* ChannelWatch
		const work = yield* ChannelWatchWork.make
		const run = yield* Program.make
		const registry = yield* Engine.Registry
		return watch
			.toLayer((key) => run(key, work.handle, watches.finish))
			.pipe(
				Layer.provideMerge(
					Layer.effectDiscard(registry.register(watch, work.authorize)),
				),
			)
	}),
)
const deliveryLayer = Layer.unwrap(
	Effect.gen(function* () {
		const queue = yield* ChannelQueue
		const work = yield* ChannelDeliveryWork.make
		const run = yield* Program.make
		const registry = yield* Engine.Registry
		return delivery
			.toLayer((key) => run(key, work.handle, queue.finish))
			.pipe(
				Layer.provideMerge(
					Layer.effectDiscard(registry.register(delivery, work.authorize)),
				),
			)
	}),
)
export const layer = Layer.mergeAll(inputLayer, watchLayer, deliveryLayer)
