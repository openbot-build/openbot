import { Bot, type Chat } from "@openbot-build/core"
import { Context, Effect, Layer, type Scope } from "effect"
import type { Prompt, Tool, Toolkit } from "effect/ai"

/**
 * The tools that the host program gives to every Turn of every Chat, such as
 * the tools of the development server or of a test. A real server gives none.
 * Each Turn registers the tools and their handlers in its own Scope.
 */
export class HostTools extends Context.Service<
	HostTools,
	{
		readonly register: Effect.Effect<
			Bot.ToolRegistration,
			never,
			Bot.Context | Scope.Scope
		>
	}
>()("@openbot-build/openbot/chats/HostTools") {}

/** No tools of the host. Each Turn has only the tools of OpenBot. */
export const none = Layer.succeed(
	HostTools,
	HostTools.of({
		register: Effect.succeed({
			tools: {},
			handlers: Context.empty(),
		}),
	}),
)

/**
 * Gives every Turn the tools of `toolkit`. `handlers` gives the handlers of
 * these tools for the Turns of one Chat. Each Turn builds them when it starts,
 * and closes them when it ends.
 */
export const layer = <Tools extends Record<string, Tool.Any>>(input: {
	readonly toolkit: Toolkit.Toolkit<Tools>
	readonly instructions?: Prompt.Prompt
	readonly handlers: (chat: Chat.Id) => Layer.Layer<Tool.HandlersFor<Tools>>
}) =>
	Layer.succeed(
		HostTools,
		HostTools.of({
			register: Effect.gen(function* () {
				const context = yield* Bot.Context
				const chat = (yield* context.at).chat
				const handlers = yield* Layer.build(input.handlers(chat))
				// Host tool names come from server configuration. The public service keeps no fixed names.
				return {
					tools: input.toolkit.tools,
					handlers,
					...(input.instructions === undefined
						? {}
						: { instructions: input.instructions }),
				}
			}).pipe(Effect.orDie),
		}),
	)
