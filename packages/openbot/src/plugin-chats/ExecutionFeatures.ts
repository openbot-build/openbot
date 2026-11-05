import type * as WorkflowTools from "../apps-contract/apps/WorkflowTools.ts"
import type { Definition } from "../tools-contract/chats/ToolDefinitions.ts"
import { Bot, Chat } from "@openbot-build/core"
import { Execution } from "@openbot-build/domain"
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
import type { Work } from "../conversation-contract/capabilities/Work.ts"
import * as BotFeatures from "../conversation-contract/chats/BotFeatures.ts"
import * as Registration from "../tools-contract/plugins/Registration.ts"
import type { Fence } from "@openbot-build/server-execution/execution/Store"
import * as ChatFeatures from "./ChatFeatures.ts"

/** The input to give back one saved tool. A host tool keeps the scope of its own registration. */
export interface ToolInput {
	readonly name: string
	readonly notify: BotFeatures.Notify
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

export interface Service {
	/**
	 * Holds the pinned features of a Turn for the phase scope, and builds their
	 * tools for this fence with one Gate. A pinned feature with a new version
	 * fails with a conflict.
	 */
	readonly open: (
		fence: Fence,
		frame: Gate.Frame,
		pins: ReadonlyArray<BotFeatures.Pin>,
	) => Effect.Effect<
		typeof ChatFeatures.ChatFeatures.Service,
		Execution.Conflict,
		Scope.Scope
	>
	readonly restoreTool: (
		fence: Fence,
		frame: typeof Work.Service,
		input: ToolInput,
	) => Effect.Effect<
		Bot.ToolRegistration<{}, never, never>,
		never,
		Bot.Context | Scope.Scope
	>
	/** Gives back a saved tool from its definition, through the present features. */
	readonly restore: (
		fence: Fence,
		definition: Definition,
	) => Effect.Effect<Option.Option<WorkflowTools.Entry>, never, Scope.Scope>
}

export class ExecutionFeatures extends Context.Service<
	ExecutionFeatures,
	Service
>()("@openbot-build/openbot/plugin-chats/ExecutionFeatures") {}

const make = Effect.gen(function* () {
	const features = yield* BotFeatures.BotFeatures
	const gates = yield* Gate.Gates
	// The layer scope must not reach a Turn: the phase scope owns its tools.
	const services = yield* Effect.context<
		Exclude<
			Effect.Services<ReturnType<typeof ChatFeatures.make>>,
			Chat.Approvals | Scope.Scope
		>
	>().pipe(Effect.map(Context.omit(Scope.Scope)))

	const open = (
		fence: Fence,
		frame: Gate.Frame,
		pins: ReadonlyArray<BotFeatures.Pin>,
	) =>
		Effect.gen(function* () {
			const held = yield* features.hold(pins).pipe(
				Effect.catchTag("BotFeatureVersionChanged", (error) =>
					Effect.logWarning(
						"A Turn uses a version of a bot feature that the server does not have.",
					).pipe(
						Effect.annotateLogs({
							feature: error.id,
							pinned: error.pinned,
							present: error.present,
						}),
						Effect.andThen(Execution.Conflict.make({ id: fence.id })),
					),
				),
			)
			const gate = yield* gates.durable(fence, frame)
			const prepared = yield* Effect.forEach(held, ({ pin, contribution }) =>
				Effect.map(
					contribution.prepare(fence, pin.settings),
					(feature): ChatFeatures.Prepared => ({ contribution, feature }),
				),
			).pipe(Effect.provideService(Gate.Gate, gate))
			return yield* ChatFeatures.make(fence, prepared).pipe(
				Effect.provideService(Chat.Approvals, Approvals.durable(gate)),
				Effect.provideContext(services),
			)
		})

	const restoreTool = (
		fence: Fence,
		frame: typeof Work.Service,
		input: ToolInput,
	) =>
		Effect.gen(function* () {
			const held = yield* features.holdPresent
			// A feature that claims the name has priority over host names, as in a Turn.
			const owner = Arr.findFirst(
				held,
				({ contribution }) =>
					(!input.policy.review || contribution.review) &&
					Arr.contains(contribution.restores, input.name),
			)
			if (Option.isNone(owner)) return selectTool(yield* input.host, input)
			const { pin, contribution } = owner.value
			const gate = yield* gates.durable(fence, frame)
			const feature = yield* contribution
				.prepare(fence, pin.settings)
				.pipe(Effect.provideService(Gate.Gate, gate))
			if (feature.restoreTool === undefined)
				return yield* Effect.die(
					`The bot feature ${contribution.id} claims tool names but cannot give them back.`,
				)
			return selectTool(
				yield* feature.restoreTool(input, input.name, frame),
				input,
			)
		})

	const restore = (fence: Fence, definition: Definition) =>
		Effect.map(features.holdPresent, (held) =>
			Arr.findFirst(held, ({ contribution }) =>
				contribution.restore === undefined
					? Option.none()
					: contribution.restore(fence, definition),
			),
		)

	return ExecutionFeatures.of({ open, restoreTool, restore })
})

export const layer = Layer.effect(ExecutionFeatures, make)

/** Tests of the execution loop can supply tools without a product policy. */
export const none = Layer.effect(
	ExecutionFeatures,
	Effect.map(ChatFeatures.ChatFeatures, (features) => ({
		open: () => Effect.succeed(features),
		restoreTool: (_: Fence, __: typeof Work.Service, input: ToolInput) =>
			Effect.map(input.host, (registration) => selectTool(registration, input)),
		restore: () => Effect.succeedNone,
	})),
).pipe(Layer.provide(ChatFeatures.none))
