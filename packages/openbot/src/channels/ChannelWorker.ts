import {
	Authorization,
	type Caller,
	type RequestsApi,
} from "@openbot-build/api"
import { Chat, Turn } from "@openbot-build/core"
import type { ChatResponseSseEvent } from "@openbot-build/api"
import {
	Cause,
	Clock,
	Deferred,
	Duration,
	Effect,
	Fiber,
	Layer,
	Option,
	PubSub,
	Schedule,
	Schema,
	SchemaTransformation,
	Stream,
} from "effect"
import { Bots } from "../bots/Bots.ts"
import { Signals, type Signal } from "../bots/Signals.ts"
import { Backend } from "../app/Backend.ts"
import { allows } from "../authorization/Check.ts"
import { Requests } from "../capabilities/Requests.ts"
import { resolveAsPerson } from "../capabilities/Resolve.ts"
import { Organization } from "../organization/Organization.ts"
import {
	type Channel,
	type ChannelEvent,
	type OutboundMessage,
	Target,
} from "./Channel.ts"
import { Channels, type Conversation, type StoredChannel } from "./Channels.ts"
import {
	ChannelQueue,
	type ClaimedEvent,
	type Delivery,
} from "./ChannelQueue.ts"
import { ChannelRegistry } from "./ChannelRegistry.ts"
import { chunk } from "./Text.ts"

export interface Options {
	/** How often the worker looks for new events and messages. The default is one second. */
	readonly interval?: Duration.Input
}

/** The least time between two changes of a message while a Turn writes it. */
const editEveryMs = 1500

const working = "Working…"

type Message = Extract<ChannelEvent, { readonly _tag: "Message" }>
type Action = Extract<ChannelEvent, { readonly _tag: "Action" }>

/** The text of a finished answer, or a short note when there is none. */
export const answerOf = (response: {
	readonly status: string
	readonly output: ReadonlyArray<{
		readonly content: ReadonlyArray<{ readonly text: string }>
	}>
	readonly error: { readonly message: string } | null
}) => {
	const text = response.output
		.flatMap((message) => message.content.map((part) => part.text))
		.join("\n\n")
		.trim()
	if (response.status === "failed")
		return (
			(text.length > 0 ? text + "\n\n" : "") +
			`The Bot could not finish: ${response.error?.message ?? "unknown error"}`
		)
	if (response.status === "cancelled")
		return (text.length > 0 ? text + "\n\n" : "") + "The Bot stopped."
	return text.length > 0 ? text : "The Bot did not write an answer."
}

const decisions = {
	once: { decision: "allow", scope: "once" },
	chat: { decision: "allow", scope: "chat" },
	deny: { decision: "deny" },
} as const
const Choice = Schema.Literals(["once", "chat", "deny"])
type Choice = typeof Choice.Type

/** The value of an approval button: the request, the choice and the revision it saw. */
const Button = Schema.TemplateLiteralParser([
	Schema.NonEmptyString,
	" ",
	Choice,
	" ",
	Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
]).pipe(
	Schema.decodeTo(
		Schema.Struct({
			request: Schema.String,
			choice: Choice,
			revision: Schema.Int,
		}),
		SchemaTransformation.transform({
			decode: ([request, , choice, , revision]) => ({
				request,
				choice,
				revision,
			}),
			encode: ({ request, choice, revision }) =>
				[request, " ", choice, " ", revision] as const,
		}),
	),
)

const buttonValue = (request: string, choice: Choice, revision: number) =>
	Schema.encodeSync(Button)({ request, choice, revision })

const readButton = (value: string) =>
	Option.getOrUndefined(Schema.decodeUnknownOption(Button)(value))

const describe = (request: RequestsApi.CapabilityRequest) => {
	const { action, target } = request.capability
	switch (action) {
		case "plans.run":
			return "carry out its plan"
		case "tools.call":
			return `use the tool \`${target}\``
		case "apps.call":
			return `call the App \`${target}\``
		case "channels.send":
			return "post to another chat of this Channel"
		case "delegations.continue":
			return `go on with its work \`${target}\` after it reached a limit`
		default:
			return `do \`${action}\` on \`${target}\``
	}
}

const outcome = (request: RequestsApi.CapabilityRequest) => {
	switch (request.status) {
		case "pending":
			return "Waiting for a decision."
		case "allowed":
			return request.decision?.scope === "chat"
				? "Allowed in this chat."
				: request.decision?.scope === "lifetime"
					? "Allowed."
					: "Allowed once."
		case "denied":
			return "Denied."
		case "expired":
			return "Nobody decided in time, so it is denied."
		case "cancelled":
			return "The request ended."
	}
}

/** The card of a request. It has buttons only while the request waits. */
const requestCard = (
	request: RequestsApi.CapabilityRequest,
	botName: string,
	approverName: string | null,
): OutboundMessage => ({
	markdown: [
		`**${botName}** wants to ${describe(request)}.`,
		request.reason.length > 0 ? `Reason: ${request.reason}` : "",
		approverName === null ? "" : `This needs a decision from ${approverName}.`,
		outcome(request),
	]
		.filter((line) => line.length > 0)
		.join("\n\n"),
	...(request.status === "pending"
		? {
				buttons: [
					{
						label: "Allow once",
						value: buttonValue(request.id, "once", request.revision),
						style: "primary" as const,
					},
					{
						label: "Allow in this chat",
						value: buttonValue(request.id, "chat", request.revision),
					},
					{
						label: "Deny",
						value: buttonValue(request.id, "deny", request.revision),
						style: "danger" as const,
					},
				],
			}
		: {}),
})

/**
 * Handles the work of all Channels: the events that came in, the messages that go out,
 * the end of each Turn, and the cards of requests.
 */
export const layer = (options: { readonly publicOrigin: string } & Options) =>
	Layer.effectDiscard(
		Effect.gen(function* () {
			const channels = yield* Channels
			const queue = yield* ChannelQueue
			const registry = yield* ChannelRegistry
			const backend = yield* Backend
			const bots = yield* Bots
			const organization = yield* Organization
			const requests = yield* Requests
			const signals = yield* Signals
			const services = yield* Effect.context<
				| Effect.Services<ReturnType<typeof resolveAsPerson>>
				| Effect.Services<ReturnType<typeof allows>>
				| Effect.Services<ReturnType<typeof bots.access>>
			>()
			const scope = yield* Effect.scope
			const interval = options.interval ?? Duration.seconds(1)

			const nameOf = (organizationId: string, userId: string) =>
				organization.member(organizationId, userId).pipe(
					Effect.map(
						Option.match({
							onNone: () => userId,
							onSome: (member) => member.name ?? member.email ?? userId,
						}),
					),
					Effect.orElseSucceed(() => userId),
				)

			/** Where only the sender should see a message about themself. */
			const privateTarget = (channel: Channel, event: ChannelEvent): Target =>
				event.conversation.kind === "direct"
					? Target.Conversation({ conversation: event.conversation.key })
					: channel.features.private
						? Target.Private({
								conversation: event.conversation.key,
								person: event.sender.externalId,
							})
						: Target.Person({ person: event.sender.externalId })

			const tellSender = (
				organizationId: string,
				stored: StoredChannel,
				channel: Channel,
				event: ChannelEvent,
				markdown: string,
			) =>
				queue.notice({
					organizationId,
					channelId: stored.id,
					target: privateTarget(channel, event),
					message: { markdown },
				})

			/** A person who is not linked gets a code, and nothing runs. */
			const askToLink = (
				organizationId: string,
				stored: StoredChannel,
				channel: Channel,
				event: ChannelEvent,
			) =>
				Effect.gen(function* () {
					const code = yield* channels.createLink({
						organizationId,
						channelId: stored.id,
						externalUserId: event.sender.externalId,
						displayName: event.sender.displayName,
					})
					const markdown =
						stored.linkPath === null
							? `Link your OpenBot account first. Accept this code in OpenBot within 15 minutes: \`${code}\``
							: `Link your OpenBot account first: ${options.publicOrigin}${stored.linkPath}${stored.linkPath.includes("?") ? "&" : "?"}code=${encodeURIComponent(code)}`
					yield* tellSender(organizationId, stored, channel, event, markdown)
					// Without private messages in a group, the code goes to a direct chat.
					if (event.conversation.kind === "group" && !channel.features.private)
						yield* queue.notice({
							organizationId,
							channelId: stored.id,
							target: Target.Conversation({
								conversation: event.conversation.key,
							}),
							message: {
								markdown: `${event.sender.displayName}, I sent you a direct message to link your account. If it did not come, send me a direct message first.`,
							},
						})
				})

			/** The Chat of a chat. A new chat gets a new Chat of the actor of the Channel. */
			const chatOf = (
				organizationId: string,
				stored: StoredChannel,
				event: ChannelEvent,
			) =>
				Effect.gen(function* () {
					const found = yield* channels.conversation(
						stored.id,
						event.conversation.key,
					)
					if (Option.isSome(found)) {
						// The owner may have deleted the Chat. Then the chat starts again.
						const chat = Chat.Id.make(found.value.chat)
						const owned = yield* backend.forCaller({
							kind: "member",
							organizationId,
							userId: found.value.owner,
						})
						const exists = yield* owned.read(chat).pipe(
							Effect.as(true),
							Effect.catchTag("ChatNotFound", () => Effect.succeed(false)),
						)
						if (exists) return { chat, owner: found.value.owner }
					}
					const actor: Caller = {
						kind: "member",
						organizationId,
						userId: stored.actor,
					}
					const bot = yield* bots
						.access(actor, stored.bot, "delegate")
						.pipe(Effect.provideContext(services))
					const chats = yield* backend.forCaller(actor)
					const title =
						event.conversation.title ??
						(event.conversation.kind === "direct"
							? `${stored.name}: ${event.sender.displayName}`
							: stored.name)
					const created = yield* chats.create({
						bot,
						kind: "channel",
						chain: {
							organizationId,
							userId: stored.actor,
							bots: [bot.id],
							chats: [],
						},
						channel: {
							channel: stored.id,
							conversation: event.conversation.key,
							group: event.conversation.kind === "group",
						},
						title,
					})
					yield* channels.saveConversation({
						organizationId,
						channelId: stored.id,
						key: event.conversation.key,
						kind: event.conversation.kind,
						title: event.conversation.title ?? null,
						chat: created.chat.id,
						owner: stored.actor,
					})
					return { chat: created.chat.id, owner: stored.actor }
				})

			/** Shows the text of a running Turn in its message, at most once each 1.5 seconds. */
			const follow = (input: {
				readonly organizationId: string
				readonly stored: StoredChannel
				readonly channel: Channel
				readonly conversation: string
				readonly chat: string
				readonly events: Stream.Stream<ChatResponseSseEvent>
			}) =>
				Effect.gen(function* () {
					let started = false,
						text = "",
						shown = 0,
						ref: { readonly conversation: string; readonly id: string } | null =
							null
					yield* input.events.pipe(
						Stream.runForEach(({ data }) =>
							Effect.gen(function* () {
								if (!started) {
									started = true
									if (input.channel.features.edit)
										ref = yield* input.channel
											.send(
												Target.Conversation({
													conversation: input.conversation,
												}),
												{ markdown: working },
											)
											.pipe(Effect.orElseSucceed(() => null))
									yield* queue.startReply({
										organizationId: input.organizationId,
										channelId: input.stored.id,
										target: Target.Conversation({
											conversation: input.conversation,
										}),
										chat: input.chat,
										turn: data.turn,
										ref,
									})
								}
								if (data.type !== "response.output_text.delta") return
								text += data.delta
								const now = yield* Clock.currentTimeMillis
								if (
									ref === null ||
									now - shown < editEveryMs ||
									text.length + 2 > input.channel.features.maxLength
								)
									return
								shown = now
								yield* input.channel
									.edit(ref, { markdown: text + " …" })
									.pipe(Effect.ignore)
							}),
						),
					)
				}).pipe(
					Effect.catchCause((cause) =>
						Effect.logDebug("A Channel could not show a running Turn", cause),
					),
				)

			const onMessage = (
				claimed: ClaimedEvent,
				stored: StoredChannel,
				channel: Channel,
				event: Message,
				userId: string,
			) =>
				Effect.gen(function* () {
					const organizationId = claimed.organizationId
					const caller: Caller = { kind: "member", organizationId, userId }
					const allowed = yield* allows(caller, {
						action: "use",
						resource: Authorization.Channel.make({
							organizationId,
							id: stored.id,
						}),
					}).pipe(Effect.provideContext(services))
					const active = yield* organization.activeMember(
						organizationId,
						userId,
					)
					if (!allowed || Option.isNone(active))
						return yield* tellSender(
							organizationId,
							stored,
							channel,
							event,
							"You may not use this Channel. Ask an administrator of your organization.",
						)
					const found = yield* chatOf(organizationId, stored, event).pipe(
						Effect.catchTag(["BotNotFound", "Forbidden", "Pending"], () =>
							Effect.succeed(null),
						),
					)
					if (found === null)
						return yield* tellSender(
							organizationId,
							stored,
							channel,
							event,
							"This Channel cannot work now: its actor cannot give work to its Bot. Ask an administrator to check the Channel.",
						)
					const { chat, owner } = found
					const chats = yield* backend.forCaller({
						kind: "member",
						organizationId,
						userId: owner,
					})
					// In a group, the Bot must know who speaks.
					const input =
						event.conversation.kind === "group"
							? `${yield* nameOf(organizationId, userId)}: ${event.text}`
							: event.text
					// A message for a running Turn of the same person goes into it. A message of
					// another person waits for its own Turn. The final answer of each Turn goes
					// to the chat when the Turn ends.
					// The live text of a new Turn shows in its own fiber until the Turn ends.
					// This event is done as soon as the Chat takes the message.
					const accepted = yield* Deferred.make<boolean>()
					const run = Effect.scoped(
						Effect.gen(function* () {
							const result = yield* chats.deliverStream(chat, {
								input,
								author: userId,
							})
							yield* Deferred.succeed(accepted, true)
							if (Option.isSome(result.events))
								yield* follow({
									organizationId,
									stored,
									channel,
									conversation: event.conversation.key,
									chat,
									events: result.events.value,
								})
						}),
					).pipe(Effect.onExit(() => Deferred.succeed(accepted, false)))
					const fiber = yield* Effect.forkIn(run, scope)
					if (!(yield* Deferred.await(accepted))) yield* Fiber.join(fiber)
				})

			const onAction = (
				claimed: ClaimedEvent,
				stored: StoredChannel,
				channel: Channel,
				event: Action,
				userId: string,
			) =>
				Effect.gen(function* () {
					const organizationId = claimed.organizationId
					yield* channel.acknowledge(event).pipe(Effect.ignore)
					const button = readButton(event.value)
					if (button === undefined) return
					const caller: Caller = { kind: "member", organizationId, userId }
					const allowed = yield* allows(caller, {
						action: "resolve",
						resource: Authorization.Request.make({
							organizationId,
							ownerUserId: userId,
							id: button.request,
						}),
					}).pipe(Effect.provideContext(services))
					const answer = allowed
						? yield* resolveAsPerson(caller, button.request, {
								expected: button.revision,
								...decisions[button.choice],
							}).pipe(
								Effect.provideContext(services),
								Effect.as(null),
								Effect.catchTags({
									RequestNotFound: () =>
										Effect.succeed(
											"Only the person that the work is for can decide this request.",
										),
									RequestConflict: () =>
										Effect.succeed(
											"This request was already decided, or it changed.",
										),
								}),
							)
						: "You may not decide requests."
					if (answer !== null)
						yield* tellSender(organizationId, stored, channel, event, answer)
				})

			const handleEvent = (claimed: ClaimedEvent) =>
				Effect.gen(function* () {
					const found = yield* channels.get(
						claimed.organizationId,
						claimed.channelId,
					)
					// A deleted or disabled Channel drops its events.
					if (Option.isNone(found) || !found.value.enabled) return
					const stored = found.value
					const channel = yield* registry.get(claimed.organizationId, stored)
					const event = claimed.event
					if (
						event._tag === "Message" &&
						event.conversation.kind === "group" &&
						!event.mentioned
					)
						return
					const identity = yield* channels.identity(
						stored.id,
						event.sender.externalId,
					)
					if (Option.isNone(identity)) {
						if (event._tag === "Action")
							yield* channel.acknowledge(event).pipe(Effect.ignore)
						return yield* askToLink(
							claimed.organizationId,
							stored,
							channel,
							event,
						)
					}
					const userId = identity.value.userId
					if (event._tag === "Message")
						yield* onMessage(claimed, stored, channel, event, userId)
					else yield* onAction(claimed, stored, channel, event, userId)
				})

			/** Sends one message. A long text goes out in parts, and the first part changes the old message. */
			const deliver = (delivery: Delivery) =>
				Effect.gen(function* () {
					const found = yield* channels.get(
						delivery.organizationId,
						delivery.channelId,
					)
					if (Option.isNone(found)) return
					const channel = yield* registry.get(
						delivery.organizationId,
						found.value,
					)
					const parts = chunk(
						delivery.message.markdown,
						channel.features.maxLength,
					)
					const [first = "", ...rest] = parts
					const last = parts.length - 1
					const message = (text: string, index: number) => ({
						markdown: text,
						// Buttons go with the last part.
						...(index === last && delivery.message.buttons !== undefined
							? { buttons: delivery.message.buttons }
							: {}),
					})
					const ref =
						delivery.ref !== null && channel.features.edit
							? yield* channel
									.edit(delivery.ref, message(first, 0))
									.pipe(Effect.as(delivery.ref))
							: yield* channel.send(delivery.target, message(first, 0))
					for (const [index, text] of rest.entries())
						yield* channel.send(
							Target.Conversation({ conversation: ref.conversation }),
							message(text, index + 1),
						)
					yield* queue.finishDelivery(delivery, ref)
				}).pipe(
					Effect.catchTag("ChannelDeliveryFailed", (failure) =>
						Effect.logWarning("A Channel message did not go out", failure).pipe(
							Effect.andThen(
								queue.retryDelivery(
									delivery,
									failure.retryAfterMs,
									!failure.retry,
								),
							),
						),
					),
				)

			/** Puts the final answer of a Turn in a chat of a Channel. */
			const finishTurn = (input: {
				readonly organizationId: string
				readonly chat: string
				readonly turn: string
			}) =>
				Effect.gen(function* () {
					const conversation = yield* channels.conversationOfChat(input.chat)
					if (Option.isNone(conversation)) return
					const chats = yield* backend.forCaller({
						kind: "member",
						organizationId: input.organizationId,
						userId: conversation.value.owner,
					})
					const result = yield* chats.turn(
						Chat.Id.make(input.chat),
						input.turn as Turn.Id,
					)
					if (!Turn.isTerminal(result.turn.status)) return
					yield* queue.finishReply({
						organizationId: input.organizationId,
						channelId: conversation.value.channelId,
						target: Target.Conversation({
							conversation: conversation.value.key,
						}),
						chat: input.chat,
						turn: input.turn,
						message: { markdown: answerOf(result.response) },
					})
				})

			/** Where a request card goes: the direct chat of the approver, or the chat of the work. */
			const cardTarget = (
				conversation: Conversation,
				request: RequestsApi.CapabilityRequest,
			) =>
				Effect.gen(function* () {
					if (request.approver._tag !== "Person")
						return { target: null, approver: null }
					const identity = yield* channels.identityOfUser(
						conversation.channelId,
						request.approver.userId,
					)
					return Option.match(identity, {
						onSome: (identity) => ({
							target: Target.Person({ person: identity.externalUserId }),
							approver: null,
						}),
						onNone: () => ({
							target: Target.Conversation({ conversation: conversation.key }),
							approver:
								request.approver._tag === "Person"
									? request.approver.userId
									: null,
						}),
					})
				})

			const onRequest = (organizationId: string, id: string) =>
				Effect.gen(function* () {
					const found = yield* requests.find(organizationId, id)
					if (Option.isNone(found)) return
					const { request, chain } = found.value
					// The work may run in a Chat below the chat, such as a task Chat.
					let conversation = Option.none<Conversation>()
					for (const chat of [request.chat, ...chain.chats].reverse())
						if (Option.isNone(conversation))
							conversation = yield* channels.conversationOfChat(chat)
					if (Option.isNone(conversation)) return
					const known =
						(yield* queue.requestRef(conversation.value.channelId, id)) !== null
					if (request.status !== "pending" && !known) return
					const where = yield* cardTarget(conversation.value, request)
					if (where.target === null) return
					const bot = yield* bots.find(organizationId, request.bot)
					yield* queue.putRequest({
						organizationId,
						channelId: conversation.value.channelId,
						target: where.target,
						request: id,
						message: requestCard(
							request,
							Option.match(bot, {
								onNone: () => "A Bot",
								onSome: (bot) => bot.name,
							}),
							where.approver === null
								? null
								: yield* nameOf(organizationId, where.approver),
						),
					})
				})

			const onSignal = (signal: Signal) =>
				Effect.gen(function* () {
					if (signal._tag === "TurnChanged" && signal.status !== "Running")
						yield* finishTurn({
							organizationId: signal.organizationId,
							chat: signal.chat,
							turn: signal.turn,
						})
					if (signal._tag === "RequestChanged")
						yield* onRequest(signal.organizationId, signal.request)
				})

			const subscription = yield* PubSub.subscribe(signals.pubsub)
			yield* Stream.fromSubscription(subscription).pipe(
				Stream.runForEach((signal) =>
					Effect.forkIn(
						onSignal(signal).pipe(
							Effect.catchCause((cause) =>
								Effect.logWarning("A Channel could not follow a change", cause),
							),
						),
						scope,
					),
				),
				Effect.forkScoped,
			)

			// New events, one by one for each chat.
			yield* queue.claimEvents.pipe(
				Effect.flatMap((claimed) =>
					Effect.forEach(
						claimed,
						(entry) =>
							handleEvent(entry).pipe(
								Effect.andThen(queue.finishEvent(entry)),
								// An event that was stopped, such as at shut down, is tried again with no warning.
								Effect.catchCause((cause) =>
									Cause.hasInterruptsOnly(cause)
										? queue.retryEvent(entry)
										: Effect.logWarning(
												"A Channel event failed. It is tried again later.",
												cause,
											).pipe(Effect.andThen(queue.retryEvent(entry))),
								),
							),
						{ concurrency: 4, discard: true },
					),
				),
				Effect.catchCause((cause) =>
					Effect.logWarning("The Channel inbox failed", cause),
				),
				Effect.repeat(Schedule.spaced(interval)),
				Effect.forkScoped,
			)
			// Messages that wait to go out.
			yield* queue.claimDeliveries.pipe(
				Effect.flatMap((due) =>
					Effect.forEach(due, deliver, { concurrency: 4, discard: true }),
				),
				Effect.catchCause((cause) =>
					Effect.logWarning("The Channel outbox failed", cause),
				),
				Effect.repeat(Schedule.spaced(interval)),
				Effect.forkScoped,
			)
			// A Turn that ended while no instance listened still gets its answer.
			yield* queue.liveReplies.pipe(
				Effect.flatMap((live) =>
					Effect.forEach(
						live,
						(reply) => finishTurn(reply).pipe(Effect.ignore),
						{ discard: true },
					),
				),
				Effect.catchCause((cause) =>
					Effect.logWarning("Channel replies could not be checked", cause),
				),
				Effect.repeat(Schedule.spaced(Duration.seconds(30))),
				Effect.forkScoped,
			)
		}),
	)
