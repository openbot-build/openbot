import * as DelegationTools from "../bots/WorkflowTools.ts"
import * as WorkflowTools from "../apps/WorkflowTools.ts"
import type { Definition } from "./ToolDefinitions.ts"
import { Chat } from "@openbot-build/core"
import { Context, Effect, Layer, Option } from "effect"
import * as Approvals from "../capabilities/Approvals.ts"
import * as Gate from "../capabilities/Gate.ts"
import type { Fence } from "../execution/Store.ts"
import * as AppTools from "../plugins/apps/AppTools.ts"
import * as BotTools from "../plugins/bots/BotTools.ts"
import * as ChannelTools from "../plugins/channels/ChannelTools.ts"
import * as ComputerTools from "../plugins/computers/ComputerTools.ts"
import * as WorkTools from "../plugins/work/WorkTools.ts"
import * as ChatFeatures from "./ChatFeatures.ts"

/** Build the approval gate and every tool that holds it in one execution scope. */
const open = (fence: Fence, frame: Gate.Frame) =>
	Effect.gen(function* () {
		const gate = yield* Gate.durable(fence, frame)
		return yield* Effect.gen(function* () {
			const apps = yield* AppTools.durable(fence)
			const bots = yield* BotTools.durable(fence)
			const work = yield* WorkTools.durable(fence)
			const channels = yield* ChannelTools.durable(fence)
			const computers = yield* ComputerTools.make
			return yield* ChatFeatures.make.pipe(
				Effect.provideService(AppTools.AppTools, apps),
				Effect.provideService(BotTools.BotTools, bots),
				Effect.provideService(WorkTools.WorkTools, work),
				Effect.provideService(ChannelTools.ChannelTools, channels),
				Effect.provideService(ComputerTools.ComputerTools, computers),
				Effect.provideService(Chat.Approvals, Approvals.durable(gate)),
			)
		}).pipe(Effect.provideService(Gate.Gate, gate))
	})

const make = Effect.gen(function* () {
	const workflows = yield* WorkflowTools.make
	const delegations = yield* DelegationTools.make
	const services =
		yield* Effect.context<Effect.Services<ReturnType<typeof open>>>()
	return {
		restore: (fence: Fence, definition: Definition) =>
			Option.orElse(workflows.restore(fence, definition), () =>
				delegations.restore(fence, definition),
			),
		open: (
			fence: Fence,
			frame: Gate.Frame,
		): Effect.Effect<typeof ChatFeatures.ChatFeatures.Service> =>
			open(fence, frame).pipe(Effect.provideContext(services)),
	}
})

export class ExecutionFeatures extends Context.Service<
	ExecutionFeatures,
	Effect.Success<typeof make>
>()("@openbot-build/openbot/chats/ExecutionFeatures") {}
export const layer = Layer.effect(ExecutionFeatures, make)

/** Tests of the execution loop can supply tools without a product policy. */
export const none = Layer.effect(
	ExecutionFeatures,
	Effect.map(ChatFeatures.ChatFeatures, (features) => ({
		open: () => Effect.succeed(features),
		restore: (_: Fence, __: Definition): Option.Option<WorkflowTools.Entry> =>
			Option.none(),
	})),
).pipe(Layer.provide(ChatFeatures.none))
