import * as DelegationTools from "../plugin-bots/WorkflowTools.ts"
import * as WorkflowTools from "../apps-contract/apps/WorkflowTools.ts"
import type { Definition } from "../tools-contract/chats/ToolDefinitions.ts"
import { Bot, Chat } from "@openbot-build/core"
import {
	Array as Arr,
	Context,
	Effect,
	Layer,
	Option,
	Record as Rec,
	Scope,
} from "effect"
import * as Approvals from "../conversation-contract/capabilities/Approvals.ts"
import * as Gate from "../conversation-contract/capabilities/Gate.ts"
import { Work } from "../conversation-contract/capabilities/Work.ts"
import * as Registration from "../tools-contract/plugins/Registration.ts"
import type { Fence } from "../server-execution/execution/Store.ts"
import * as AppTools from "../plugin-apps/AppTools.ts"
import * as BotTools from "../plugin-bots/BotTools.ts"
import * as ChannelTools from "../plugin-channels/ChannelTools.ts"
import * as ComputerTools from "../plugin-computers/ComputerTools.ts"
import * as WorkTools from "../plugin-work/WorkTools.ts"
import * as ChatFeatures from "./ChatFeatures.ts"

/** Build the approval gate and every tool that holds it in one execution scope. */
const open = (fence: Fence, frame: Gate.Frame) =>
	Effect.gen(function* () {
		const gate = yield* (yield* Gate.Gates).durable(fence, frame)
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

/** Resolve one tool. A host tool keeps the scope of its own registration. */
interface ToolInput {
	readonly name: string
	readonly notify: Parameters<
		typeof ComputerTools.ComputerTools.Service.register
	>[0]["notify"]
	readonly host: Effect.Effect<
		Bot.ToolRegistration,
		never,
		Bot.Context | Scope.Scope
	>
	readonly policy: { readonly review: boolean; readonly plan: boolean }
}
const selectTool = (registration: Bot.ToolRegistration, input: ToolInput) =>
	Registration.select(
		{
			...registration,
			tools: Rec.filter(registration.tools, (_, name) => name === input.name),
		},
		input.policy,
	)

const restoreTool = (
	fence: Fence,
	frame: typeof Work.Service,
	input: ToolInput,
) =>
	Effect.gen(function* () {
		// Computer tools have the same priority over host names as in a Turn.
		if (
			!input.policy.review &&
			Arr.contains(Rec.values(ComputerTools.names), input.name)
		) {
			const gate = yield* (yield* Gate.Gates).durable(fence, frame)
			const registration = yield* Effect.gen(function* () {
				const computers = yield* ComputerTools.make
				return yield* computers.restore(input, input.name, frame)
			}).pipe(Effect.provideService(Gate.Gate, gate))
			return selectTool(registration, input)
		}
		return selectTool(yield* input.host, input)
	})

export interface Service {
	readonly restoreTool: (
		fence: Fence,
		frame: typeof Work.Service,
		input: ToolInput,
	) => Effect.Effect<
		Bot.ToolRegistration<{}, never, never>,
		never,
		Bot.Context | Scope.Scope
	>
	readonly restore: (
		fence: Fence,
		definition: Definition,
	) => Option.Option<WorkflowTools.Entry>
	readonly open: (
		fence: Fence,
		frame: Gate.Frame,
	) => Effect.Effect<typeof ChatFeatures.ChatFeatures.Service>
}

export class ExecutionFeatures extends Context.Service<
	ExecutionFeatures,
	Service
>()("@openbot-build/openbot/plugin-chats/ExecutionFeatures") {}

const make = Effect.gen(function* () {
	const workflows = yield* WorkflowTools.make
	const delegations = yield* DelegationTools.make
	const services =
		yield* Effect.context<Effect.Services<ReturnType<typeof open>>>()
	const toolServices = yield* Effect.context<
		Exclude<
			Effect.Services<ReturnType<typeof restoreTool>>,
			Bot.Context | Scope.Scope
		>
	>().pipe(
		// Keep the scope and Bot context of the current phase.
		Effect.map(Context.omit(Scope.Scope, Bot.Context)),
	)
	return ExecutionFeatures.of({
		restoreTool: (fence: Fence, frame: typeof Work.Service, input: ToolInput) =>
			restoreTool(fence, frame, input).pipe(
				Effect.provideContext(toolServices),
			),
		restore: (fence: Fence, definition: Definition) =>
			Option.orElse(workflows.restore(fence, definition), () =>
				delegations.restore(fence, definition),
			),
		open: (
			fence: Fence,
			frame: Gate.Frame,
		): Effect.Effect<typeof ChatFeatures.ChatFeatures.Service> =>
			open(fence, frame).pipe(Effect.provideContext(services)),
	})
})

export const layer = Layer.effect(ExecutionFeatures, make)

/** Tests of the execution loop can supply tools without a product policy. */
export const none = Layer.effect(
	ExecutionFeatures,
	Effect.map(ChatFeatures.ChatFeatures, (features) => ({
		open: () => Effect.succeed(features),
		restoreTool: (_: Fence, __: typeof Work.Service, input: ToolInput) =>
			Effect.map(input.host, (registration) => selectTool(registration, input)),
		restore: (_: Fence, __: Definition): Option.Option<WorkflowTools.Entry> =>
			Option.none(),
	})),
).pipe(Layer.provide(ChatFeatures.none))
