import { Execution } from "@openbot-build/domain"
import type { Fence } from "../../execution/Store.ts"
import { Bot, type Chat, type ChatStore } from "@openbot-build/core"
import {
	Array as Arr,
	Cause,
	Context,
	Effect,
	Layer,
	Option,
	pipe,
	Schema,
	String as Str,
} from "effect"
import { Prompt, Tool, Toolkit } from "effect/ai"
import { Answer, Gate } from "../../capabilities/Gate.ts"
import { Work } from "../../capabilities/Work.ts"
import { Target } from "../../channels/Channel.ts"
import { ChannelQueue } from "../../channels/ChannelQueue.ts"
import { Channels } from "../../channels/Channels.ts"
import * as ChatHost from "../../chats/ChatHost.ts"
import { toolJson } from "../ToolJson.ts"
import * as Report from "../../errors/Report.ts"

/** The Channel tools. Their parameters are JSON Schema, like App tools. */
export type Tools = import("../ToolEntry.ts").Tools

export const names = { send: "openbot_channel_send" } as const

const SendInput = Schema.Struct({
	conversation: Schema.String,
	markdown: Schema.String.check(Schema.isMinLength(1)),
	reason: Schema.optionalKey(Schema.String),
})

const json = toolJson

/** The Chat data used by the Channel tools. */
interface ForOwnerInput {
	readonly read: (
		chat: Chat.Id,
	) => Effect.Effect<
		Chat.View<ChatHost.Values>,
		Chat.ChatNotFound | ChatStore.ChatStoreError
	>
}

/**
 * Registers Channel tools with the identity of the Turn. In a channel Chat, it tells
 * the Bot where it talks, and lets it post to other chats of the same Channel.
 * Each post goes through the capability gate.
 */
export class ChannelTools extends Context.Service<
	ChannelTools,
	{
		readonly register: (
			input: ForOwnerInput,
		) => Effect.Effect<Bot.ToolRegistration, never, Bot.Context | Work>
	}
>()("@openbot-build/openbot/plugins/channels/ChannelTools") {}

const makeWith = (fence?: Fence) =>
	Effect.gen(function* () {
		const channels = yield* Channels
		const queue = yield* ChannelQueue
		const gate = yield* Gate
		const report = yield* Report.make
		return ChannelTools.of({
			register: (input) =>
				Effect.gen(function* () {
					const context = yield* Bot.Context
					const at = yield* context.at
					const view = yield* input.read(at.chat)
					const state = ChatHost.hostState(view.chat)
					if (state.kind !== "channel" || state.channel === undefined)
						return { tools: {}, handlers: Context.empty() }
					const organizationId = state.chain.organizationId
					const channelId = state.channel.channel
					const stored = yield* channels.get(organizationId, channelId)
					if (Option.isNone(stored))
						return { tools: {}, handlers: Context.empty() }
					const here = yield* channels.conversation(
						channelId,
						state.channel.conversation,
					)
					const others = pipe(
						yield* channels.conversations(channelId),
						Arr.filter((chat) => chat.key !== state.channel?.conversation),
						Arr.take(20),
					)
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
						failure: Execution.Failure,
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
										site: { main: call.toolCallId, path: [] },
									}),
								),
								Effect.map((answer) => answer._tag !== "Allow"),
								// When the check fails, the post never goes out.
								Effect.catchCause((cause) =>
									Cause.hasInterruptsOnly(cause)
										? Effect.interrupt
										: report(
												"A Channel post could not be checked",
												cause,
												fence?.id,
											).pipe(
												Effect.andThen(
													gate.remember(
														call.toolCallId,
														Answer.Deny({
															reason: "OpenBot could not check this post.",
														}),
													),
												),
												Effect.as(true),
											),
								),
							),
					})
					const handle = (
						raw: unknown,
						call: { readonly toolCallId?: string | undefined },
					) =>
						Effect.gen(function* () {
							const request = yield* Schema.decodeUnknownEffect(SendInput)(raw)
							if (
								!Arr.some(others, (chat) => chat.key === request.conversation)
							)
								return json({
									error:
										"There is no such chat in this Channel. Use an ID from your instructions.",
								})
							if (fence === undefined || call.toolCallId === undefined)
								return yield* Execution.Forbidden.make({})
							const receipt = yield* queue.notice(
								fence,
								"tool:" + call.toolCallId,
								{
									channelId,
									target: Target.Conversation({
										conversation: request.conversation,
									}),
									message: { markdown: request.markdown },
								},
							)
							return json({ queued: true, executionId: receipt.executionId })
						}).pipe(
							Effect.catchCause((cause) =>
								Cause.hasInterrupts(cause) || Cause.hasDies(cause)
									? Effect.failCause(cause).pipe(Effect.orDie)
									: report("A Channel post failed", cause, fence?.id).pipe(
											Effect.flatMap(Effect.fail),
										),
							),
						)
					const own = Toolkit.make(send)
					const handlers = yield* own.toHandlers({
						openbot_channel_send: handle,
					})
					const where = Option.match(here, {
						onNone: () => "a chat",
						onSome: (chat) =>
							chat.kind === "direct"
								? "a direct chat"
								: `the group chat ${chat.title ?? chat.key}`,
					})
					const instructions = Prompt.concat(
						Prompt.empty,
						Prompt.make([
							{
								role: "system",
								content: pipe(
									[
										`You talk in ${where} of the ${stored.value.kind} Channel "${stored.value.name}". Your answer goes to the chat as it is. Write short Markdown.`,
										"In a group chat, each message starts with the name of the person who wrote it. Many people can talk in the same chat. Each Turn works for the person who wrote its message.",
										others.length === 0
											? ""
											: `Other chats of this Channel, for ${names.send}:\n` +
												pipe(
													others,
													Arr.map(
														(chat) =>
															`- ${chat.key}: ${chat.title ?? (chat.kind === "direct" ? "a direct chat" : "a group chat")}`,
													),
													Arr.join("\n"),
												),
									],
									Arr.filter(Str.isNonEmpty),
									Arr.join("\n\n"),
								),
							},
						]),
					)
					return { tools: own.tools, handlers, instructions }
				}).pipe(Effect.orDie),
		})
	})
export const make = makeWith()
export const durable = (fence: Fence) => makeWith(fence)
export const layer = Layer.effect(ChannelTools, make)
