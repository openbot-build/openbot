import { Execution } from "@openbot-build/domain"
import { Effect, Option, Stream } from "effect"
import { Store, type Fence } from "../execution/Store.ts"
import { Registry, type Authorize } from "../execution/Engine.ts"
import { Observation } from "../execution/Observation.ts"
import { ChannelQueue } from "./ChannelQueue.ts"
import { Channels } from "./Channels.ts"
import { ChannelRegistry } from "./ChannelRegistry.ts"
import * as ChannelSend from "./ChannelSend.ts"
import * as ChannelAccess from "./ChannelAccess.ts"
import { inExecution } from "../chats/ChatEncoding.ts"

export const make = Effect.gen(function* () {
	const queue = yield* ChannelQueue
	const channels = yield* Channels
	const registry = yield* ChannelRegistry
	const sends = yield* ChannelSend.make
	const store = yield* Store
	const workflows = yield* Registry
	const observation = yield* Observation
	const access = yield* ChannelAccess.make
	const authorize: Authorize = (key, actor, mode) =>
		access(key, actor, mode).pipe(
			Effect.andThen(
				Effect.gen(function* () {
					if (mode !== "advance" && mode !== "replay") return
					const saved = yield* queue.load(key)
					const source = {
						namespace: key.namespace,
						id: saved.input.sourceExecutionId,
					}
					const parent = yield* store.loadMember(source)
					const feature = yield* workflows.get(parent.workflow)
					if (Option.isNone(feature)) return yield* Execution.Forbidden.make({})
					yield* feature.value.authorize(
						source,
						saved.execution.identity.actor,
						"replay",
					)
				}),
			),
		)
	const handle = (fence: Fence) =>
		Effect.gen(function* () {
			const { execution, input } = yield* queue.load(fence)
			if (input.predecessor !== null)
				yield* observation.observe(input.predecessor, 0).pipe(Stream.runDrain)
			yield* authorize(fence, execution.identity.actor, "advance")
			const channel = yield* channels.get(
				execution.identity.owner.organizationId,
				input.channelId,
			)
			if (Option.isNone(channel)) return yield* Execution.Forbidden.make({})
			const opened = yield* registry.get(
				execution.identity.owner.organizationId,
				channel.value.id,
			)
			const ref = yield* queue.reference(input.deliveryId)
			const result = yield* sends.send(
				fence,
				opened,
				"send",
				input.target,
				input.message,
				ref,
			)
			return result
		}).pipe(
			Effect.scoped,
			Effect.flatMap(
				Option.match({
					onNone: () => Effect.void,
					onSome: (ref) => queue.finish(fence, { status: "completed", ref }),
				}),
			),
			inExecution,
		)

	return { handle, authorize }
})
