import { Bot, type Chat, Plugin } from "@openbot-build/core"
import { Context, Effect, Layer, Stream } from "effect"
import { type Tool, Toolkit } from "effect/ai"

export const pluginId = Plugin.Id.make("@openbot-build/openbot/host-tools")

/**
 * The tools that the host program gives to every Turn of every Chat, such as
 * the tools of the development server or of a test. A real server gives none.
 * The plugin adds the tools to each Turn, and gives the Turn their handlers.
 */
export class HostTools extends Context.Service<
	HostTools,
	{ readonly plugin: Plugin.Plugin<{}> }
>()("@openbot-build/openbot/chats/HostTools") {}

/** No tools of the host. Each Turn has only the tools of OpenBot. */
export const none = Layer.succeed(
	HostTools,
	HostTools.of({
		plugin: Plugin.make({ id: pluginId })(() =>
			Effect.succeed((next, options) => next(options)),
		),
	}),
)

/**
 * Gives every Turn the tools of `toolkit`. `handlers` gives the handlers of
 * these tools for the Turns of one Chat. Each Turn builds them when it starts,
 * and closes them when it ends.
 */
export const layer = <Tools extends Record<string, Tool.Any>>(input: {
	readonly toolkit: Toolkit.Toolkit<Tools>
	readonly handlers: (chat: Chat.Id) => Layer.Layer<Tool.HandlersFor<Tools>>
}) =>
	Layer.succeed(
		HostTools,
		HostTools.of({
			plugin: Plugin.make({ id: pluginId })(() =>
				Effect.succeed((next, options) =>
					Stream.unwrap(
						Effect.gen(function* () {
							const context = yield* Bot.Context
							const chat = (yield* context.at).chat
							const handlers = yield* Layer.build(input.handlers(chat))
							// The tools of the host are not in the types of the Turn, like the tools that other plugins add.
							const toolkit: Toolkit.Any = Toolkit.merge(
								yield* options.toolkit,
								input.toolkit,
							)
							return next({
								...options,
								toolkit: Effect.succeed(toolkit),
							}).pipe(Stream.provideContext(handlers))
							// Without its Chat, a Turn cannot run, so it fails.
						}).pipe(Effect.orDie),
					),
				),
			),
		}),
	)
