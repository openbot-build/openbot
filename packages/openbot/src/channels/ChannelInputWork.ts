import * as ChannelAdmission from "./ChannelAdmission.ts"
import * as ChannelSend from "./ChannelSend.ts"
import { Chat } from "@openbot-build/core"
import {
	Authorization,
	Caller,
	Execution,
	restrictExecution,
} from "@openbot-build/domain"
import { Effect, Option, Duration, String as Str } from "effect"
import { Prompt } from "effect/ai"
import { SqlClient } from "effect/sql"
import { ownerKey } from "../apps/StoredConnections.ts"
import * as Check from "../authorization/Check.ts"
import * as Resolve from "../capabilities/Resolve.ts"
import * as ChatCommands from "../chats/ChatCommands.ts"
import * as StoredChats from "../chats/StoredChats.ts"
import * as ChatHost from "../chats/ChatHost.ts"
import { InputCommands } from "../chats/InputCommands.ts"
import * as Db from "../database/Database.ts"
import { Store, type Fence } from "../execution/Store.ts"
import { Organization } from "../organization/Organization.ts"
import { Settings } from "../settings/Settings.ts"
import * as Platform from "../settings/Platform.ts"
import { ChannelInbox } from "./ChannelInbox.ts"
import { ChannelQueue } from "./ChannelQueue.ts"
import { Channels, linkLifetimeMs } from "./Channels.ts"
import { ChannelRegistry } from "./ChannelRegistry.ts"
import { ChannelWatch } from "./ChannelWatch.ts"
import { Target, type Channel, type ChannelEvent } from "./Channel.ts"
import * as Messages from "./ChannelMessages.ts"
import * as ChannelAccess from "./ChannelAccess.ts"
import { inExecution } from "../chats/ChatEncoding.ts"

export const make = Effect.gen(function* () {
	const sends = yield* ChannelSend.make
	const admit = yield* ChannelAdmission.make
	const inbox = yield* ChannelInbox
	const channels = yield* Channels
	const queue = yield* ChannelQueue
	const registry = yield* ChannelRegistry
	const watches = yield* ChannelWatch
	const inputs = yield* InputCommands
	const chats = yield* ChatCommands.make
	const db = yield* Db.make
	const sql = yield* SqlClient.SqlClient
	const store = yield* Store
	const checks = yield* Check.make
	const organization = yield* Organization
	const settings = yield* Settings
	const resolution = yield* Resolve.make
	const authorize = yield* ChannelAccess.make
	const privateTarget = (channel: Channel, event: ChannelEvent) =>
		event.conversation.kind === "direct"
			? Target.Conversation({ conversation: event.conversation.key })
			: channel.features.private
				? Target.Private({
						conversation: event.conversation.key,
						person: event.sender.externalId,
					})
				: Target.Person({ person: event.sender.externalId })
	const handle = (fence: Fence) =>
		Effect.gen(function* () {
			const { execution, input } = yield* inbox.load(fence)
			const { event, channelId } = input
			const caller = execution.identity.actor
			const organizationId = caller.organizationId
			yield* authorize(fence, caller, "advance")
			const found = yield* channels.get(organizationId, channelId)
			if (Option.isNone(found)) return yield* Execution.Forbidden.make({})
			const stored = found.value
			const channel = yield* registry.get(organizationId, stored.id)
			if (
				event._tag === "Message" &&
				event.conversation.kind === "group" &&
				!event.mentioned
			)
				return true
			const tell = (markdown: string) =>
				queue.notice(fence, "sender", {
					channelId,
					target: privateTarget(channel, event),
					message: { markdown },
				})
			// A replay sees this command receipt before it makes a link, a Chat, or an input.
			yield* store.accept(
				fence.namespace,
				Execution.CommandKey.make("channel-admit:" + fence.id),
				{ actor: caller, body: { executionId: fence.id } },
				() =>
					store.commit(
						fence,
						{},
						Effect.gen(function* () {
							yield* admit(organizationId, channelId)
							yield* authorize(fence, caller, "advance")
							const linked = yield* channels.identity(
								channelId,
								event.sender.externalId,
							)
							if (Option.isNone(linked)) {
								const linkPage = yield* stored.linkPath === null
									? Effect.succeedNone
									: Platform.publicOrigin(settings).pipe(
											Effect.map((origin) =>
												Option.some(origin + stored.linkPath),
											),
										)
								const code = yield* channels.createLink({
									organizationId,
									channelId,
									externalUserId: event.sender.externalId,
									displayName: event.sender.displayName,
								})
								yield* tell(
									Option.match(linkPage, {
										onNone: () =>
											`Link your OpenBot account first. Accept this code in OpenBot within ${Duration.toMinutes(linkLifetimeMs)} minutes: \`${code}\``,
										onSome: (page) =>
											`Link your OpenBot account first: ${page}${Str.includes("?")(page) ? "&" : "?"}code=${encodeURIComponent(code)}`,
									}),
								)
								if (
									event.conversation.kind === "group" &&
									!channel.features.private
								)
									yield* queue.notice(fence, "link-group", {
										channelId,
										target: Target.Conversation({
											conversation: event.conversation.key,
										}),
										message: {
											markdown: `${event.sender.displayName}, I sent you a direct message to link your account. If it did not come, send me a direct message first.`,
										},
									})
							} else {
								const speaker: Caller = {
									kind: "member",
									organizationId,
									userId: linked.value.userId,
								}
								if (event._tag === "Action") {
									const button = Messages.readButton(event.value)
									if (Option.isSome(button)) {
										const { request, choice, revision } = button.value
										const allowed = yield* checks.allows(speaker, {
											action: "resolve",
											resource: Authorization.Request.make({
												organizationId,
												ownerUserId: speaker.userId,
												id: request,
											}),
										})
										const answer = allowed
											? yield* resolution
													.resolveAsPerson(speaker, request, {
														expected: revision,
														commandKey: Execution.CommandKey.make(
															"channel-decision:" + fence.id,
														),
														...Messages.decisions[choice],
													})
													.pipe(
														Effect.as(Option.none<string>()),
														Effect.catchTags({
															RequestNotFound: () =>
																Effect.succeedSome(
																	"Only the person that the work is for can decide this request.",
																),
															ExecutionConflict: () =>
																Effect.succeedSome(
																	"This request was already decided, or it changed.",
																),
															ExecutionForbidden: () =>
																Effect.succeedSome(
																	"You may not decide this request now.",
																),
															RequestConflict: () =>
																Effect.succeedSome(
																	"This request was already decided, or it changed.",
																),
														}),
													)
											: Option.some("You may not decide requests.")
										if (Option.isSome(answer)) yield* tell(answer.value)
									}
								} else {
									const allowed = yield* checks.allows(speaker, {
										action: "use",
										resource: Authorization.Channel.make({
											organizationId,
											id: channelId,
										}),
									})
									if (!allowed)
										yield* tell(
											"You may not use this Channel. Ask an administrator of your organization.",
										)
									else {
										yield* sql`select pg_advisory_xact_lock(hashtextextended(${"channel-chat:" + channelId + ":" + event.conversation.key}, 0))`
										const conversation = yield* channels.conversation(
											channelId,
											event.conversation.key,
										)
										const existing =
											Option.isNone(conversation) ||
											conversation.value.owner !== caller.userId
												? Option.none<Chat.Ref>()
												: yield* StoredChats.ref(
														db,
														ownerKey(caller),
														Chat.Id.make(conversation.value.chat),
													)
										const chat =
											Option.isSome(existing) &&
											ChatHost.hostState(existing.value).bot === stored.bot
												? existing.value.id
												: (yield* chats.createChannel(caller, {
														bot: stored.bot,
														channel: {
															channel: channelId,
															conversation: event.conversation.key,
															group: event.conversation.kind === "group",
														},
														title:
															event.conversation.title ??
															(event.conversation.kind === "direct"
																? `${stored.name}: ${event.sender.displayName}`
																: stored.name),
													})).chat.id
										yield* channels.saveConversation({
											organizationId,
											channelId,
											key: event.conversation.key,
											kind: event.conversation.kind,
											title: event.conversation.title ?? null,
											chat,
											owner: caller.userId,
										})
										const member = yield* organization.member(
											organizationId,
											speaker.userId,
										)
										const name = Option.match(member, {
											onNone: () => speaker.userId,
											onSome: (member) =>
												member.name ?? member.email ?? speaker.userId,
										})
										const receipt = yield* inputs.submit(
											fence.namespace,
											Execution.CommandKey.make("channel-message:" + fence.id),
											{
												chat,
												identity: restrictExecution(
													{
														owner: execution.identity.owner,
														actor: speaker,
														botId: stored.bot,
														channel: {
															id: channelId,
															externalUserId: event.sender.externalId,
														},
													},
													[caller],
												),
												content: Prompt.make(
													event.conversation.kind === "group"
														? `${name}: ${event.text}`
														: event.text,
												),
												queue: false,
											},
										)
										yield* watches.start(fence.namespace, {
											channelId,
											conversation: event.conversation.key,
											sourceExecutionId: receipt.executionId,
											chat,
											reply: true,
										})
									}
								}
							}
							return { executionId: fence.id, start: false }
						}),
					),
			)
			return event._tag === "Action"
				? yield* sends.acknowledge(fence, channel, event)
				: true
		}).pipe(Effect.scoped, inExecution)
	return { handle, authorize }
})
