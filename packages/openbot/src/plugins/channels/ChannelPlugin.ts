import {
	Agent,
	Plugin,
	type Session,
	type SessionStore,
} from "@openbot-build/core"
import {
	Context,
	Effect,
	type JsonSchema,
	Layer,
	Option,
	Record,
	Schema,
	Stream,
} from "effect"
import { Prompt, Tool, Toolkit } from "effect/ai"
import { Gate } from "../../capabilities/Gate.ts"
import { Work } from "../../capabilities/Work.ts"
import { Target } from "../../channels/Channel.ts"
import { ChannelQueue } from "../../channels/ChannelQueue.ts"
import { Channels } from "../../channels/Channels.ts"
import * as SessionHost from "../../sessions/SessionHost.ts"

export const pluginId = Plugin.Id.make("@openbot-build/openbot/channels")

/** The tools of this plugin. Their parameters are JSON Schema, like App tools. */
export type Tools = Record<
	string,
	Tool.Dynamic<
		string,
		{
			readonly parameters: JsonSchema.JsonSchema
			readonly success: typeof Schema.Json
			readonly failure: typeof Schema.Never
			readonly failureMode: "error"
		}
	>
>

export const names = { send: "openbot_channel_send" } as const

const SendInput = Schema.Struct({
	conversation: Schema.String,
	markdown: Schema.String.check(Schema.isMinLength(1)),
	reason: Schema.optionalKey(Schema.String),
})

const json = (value: unknown): Schema.Json =>
	JSON.parse(JSON.stringify(value)) as Schema.Json

/** What the Sessions of one member give to the Channel plugin. */
interface ForOwnerInput {
	readonly read: (
		session: Session.Id,
	) => Effect.Effect<
		Session.View<SessionHost.Values>,
		Session.SessionNotFound | SessionStore.SessionStoreError
	>
}

/**
 * Builds the Channel plugin for the Sessions of one member. In a channel Session, it tells
 * the Agent where it talks, and lets it post to other chats of the same Channel.
 * It runs inside the Agent plugin, so a post goes through the capability gate.
 */
export class ChannelPlugin extends Context.Service<
	ChannelPlugin,
	{ readonly forOwner: (input: ForOwnerInput) => Plugin.Plugin<Tools> }
>()("@openbot-build/openbot/plugins/channels/ChannelPlugin") {}

export const make = Effect.gen(function* () {
	const channels = yield* Channels
	const queue = yield* ChannelQueue
	const gate = yield* Gate
	const work = Effect.serviceOption(Work).pipe(
		Effect.flatMap(Effect.fromOption),
	)
	return ChannelPlugin.of({
		forOwner: (input) =>
			Plugin.make({ id: pluginId })<Tools>(() =>
				Effect.succeed((next, options) =>
					Stream.unwrap(
						Effect.gen(function* () {
							const context = yield* Agent.Context
							const at = yield* context.at
							const view = yield* input.read(at.session)
							const state = SessionHost.hostState(view.session)
							if (state.kind !== "channel" || state.channel === undefined)
								return next(options)
							const organizationId = state.chain.organizationId
							const channelId = state.channel.channel
							const stored = yield* channels.get(organizationId, channelId)
							if (Option.isNone(stored)) return next(options)
							const here = yield* channels.conversation(
								channelId,
								state.channel.conversation,
							)
							const others = (yield* channels.conversations(channelId))
								.filter((chat) => chat.key !== state.channel?.conversation)
								.slice(0, 20)
							const send = Tool.dynamic(names.send, {
								description:
									"Post a message to another chat of this Channel. Use it only when the person asks for it.",
								parameters: {
									type: "object",
									properties: {
										conversation: {
											type: "string",
											description:
												"The ID of the chat, from the list in your instructions.",
										},
										markdown: { type: "string" },
										reason: {
											type: "string",
											description: "Why you post it, in one short sentence.",
										},
									},
									required: ["conversation", "markdown"],
								},
								success: Schema.Json,
								needsApproval: (raw, call) =>
									Schema.decodeUnknownEffect(SendInput)(raw).pipe(
										Effect.flatMap((request) =>
											gate.check({
												capability: {
													action: "channels.send",
													target: channelId,
												},
												reason:
													request.reason ??
													`Post to the chat ${request.conversation}.`,
												toolCallId: call.toolCallId,
											}),
										),
										Effect.map((answer) => answer === "pause"),
										// When the check fails, the post waits for a decision.
										Effect.catchCause((cause) =>
											Effect.logWarning(
												"A Channel post could not be checked",
												cause,
											).pipe(Effect.as(true)),
										),
									),
							}) as Tools[string]
							const handle = (raw: unknown) =>
								Effect.gen(function* () {
									const request =
										yield* Schema.decodeUnknownEffect(SendInput)(raw)
									if (!others.some((chat) => chat.key === request.conversation))
										return json({
											error:
												"There is no such chat in this Channel. Use an ID from your instructions.",
										})
									const current = yield* work
									yield* queue.notice({
										organizationId: current.chain.organizationId,
										channelId,
										target: Target.Conversation({
											conversation: request.conversation,
										}),
										message: { markdown: request.markdown },
									})
									return json({ sent: true })
								}).pipe(
									Effect.catchCause((cause) =>
										Effect.logWarning("A Channel post failed", cause).pipe(
											Effect.as(json({ error: "The post did not go out." })),
										),
									),
								)
							const own = Toolkit.make(send)
							const handlers = yield* own.toHandlers(
								Record.fromEntries([[send.name, handle]]),
							)
							const where = Option.match(here, {
								onNone: () => "a chat",
								onSome: (chat) =>
									chat.kind === "direct"
										? "a direct chat"
										: `the group chat ${chat.title ?? chat.key}`,
							})
							const instructions = Prompt.concat(
								options.instructions,
								Prompt.make([
									{
										role: "system",
										content: [
											`You talk in ${where} of the ${stored.value.kind} Channel "${stored.value.name}". Your answer goes to the chat as it is. Write short Markdown.`,
											"In a group chat, each message starts with the name of the person who wrote it. Many people can talk in the same chat. Each Turn works for the person who wrote its message.",
											others.length === 0
												? ""
												: `Other chats of this Channel, for ${names.send}:\n` +
													others
														.map(
															(chat) =>
																`- ${chat.key}: ${chat.title ?? (chat.kind === "direct" ? "a direct chat" : "a group chat")}`,
														)
														.join("\n"),
										]
											.filter((line) => line.length > 0)
											.join("\n\n"),
									},
								]),
							)
							return next({
								...options,
								instructions,
								toolkit: Effect.map(options.toolkit, (incoming) =>
									Toolkit.merge(incoming, own),
								),
							}).pipe(Stream.provideContext(handlers))
							// Without its Session, a Turn cannot run, so it fails.
						}).pipe(Effect.orDie),
					),
				),
			),
	})
})
export const layer = Layer.effect(ChannelPlugin, make)
