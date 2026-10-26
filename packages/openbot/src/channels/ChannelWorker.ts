import { Authorization, type Caller, RequestsApi } from "@openbot-build/api"
import { Chat, Turn } from "@openbot-build/core"
import type { ChatResponseSseEvent } from "@openbot-build/api"
import {
	Array as Arr,
	Cause,
	Clock,
	Duration,
	Effect,
	Exit,
	Layer,
	Option,
	pipe,
	PubSub,
	Schedule,
	Schema,
	SchemaTransformation,
	Scope,
	Stream,
	String as Str,
} from "effect"
import { Bots } from "../bots/Bots.ts"
import { Signals, type Signal } from "../bots/Signals.ts"
import { Backend } from "../app/Backend.ts"
import * as Background from "../app/Background.ts"
import * as Check from "../authorization/Check.ts"
import { Requests } from "../capabilities/Requests.ts"
import * as Resolve from "../capabilities/Resolve.ts"
import type { Chats } from "../chats/Chats.ts"
import { Organization } from "../organization/Organization.ts"
import {
	type Channel,
	type ChannelEvent,
	type MessageRef,
	type OutboundMessage,
	Target,
} from "./Channel.ts"
import {
	Channels,
	type Conversation,
	linkLifetimeMs,
	type StoredChannel,
} from "./Channels.ts"
import {
	ChannelQueue,
	type ClaimedEvent,
	type Delivery,
	leaseMs,
} from "./ChannelQueue.ts"
import { ChannelRegistry } from "./ChannelRegistry.ts"
import * as Platform from "../settings/Platform.ts"
import { Settings } from "../settings/Settings.ts"
import { chunk } from "./Text.ts"

export interface Options {
	/** How often the worker looks for new events and messages. The default is one second. */
	readonly interval?: Duration.Input
}

/** The least time between two changes of a message while a Turn writes it. */
const editEveryMs = 1500

/**
 * How often a worker renews the leases of the items it works on. Three renewals in
 * each lease mean that one failed renewal does not end a lease.
 */
const renewEvery = Duration.millis(leaseMs / 3)

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
	const text = pipe(
		response.output,
		Arr.flatMap((message) => Arr.map(message.content, (part) => part.text)),
		Arr.join("\n\n"),
		Str.trim,
	)
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
	RequestsApi.CapabilityRequestId,
	" ",
	Choice,
	" ",
	Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
]).pipe(
	Schema.decodeTo(
		Schema.toType(
			Schema.Struct({
				request: RequestsApi.CapabilityRequestId,
				choice: Choice,
				revision: Schema.Int,
			}),
		),
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

const buttonValue = (
	request: RequestsApi.CapabilityRequestId,
	choice: Choice,
	revision: number,
) =>
	Schema.encodeEffect(Button)({ request, choice, revision }).pipe(
		// A stored request always has an ID and a revision of 0 or more, so a failure here is a defect.
		Effect.orDie,
	)

const readButton = Schema.decodeUnknownOption(Button)

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

/** Where a request card goes. */
interface CardPlace {
	readonly target: Target
	/** The person who must decide, when the card goes to a chat that others see too. */
	readonly approver: Option.Option<string>
}

/** The card of a request. It has buttons only while the request waits. */
const requestCard = (
	request: RequestsApi.CapabilityRequest,
	botName: string,
	approverName: Option.Option<string>,
): Effect.Effect<OutboundMessage> =>
	Effect.gen(function* () {
		const markdown = pipe(
			[
				`**${botName}** wants to ${describe(request)}.`,
				request.reason.length > 0 ? `Reason: ${request.reason}` : "",
				Option.match(approverName, {
					onNone: () => "",
					onSome: (name) => `This needs a decision from ${name}.`,
				}),
				outcome(request),
			],
			Arr.filter((line) => line.length > 0),
			Arr.join("\n\n"),
		)
		if (request.status !== "pending") return { markdown }
		const value = (choice: Choice) =>
			buttonValue(request.id, choice, request.revision)
		return {
			markdown,
			buttons: [
				{
					label: "Allow once",
					value: yield* value("once"),
					style: "primary" as const,
				},
				{ label: "Allow in this chat", value: yield* value("chat") },
				{
					label: "Deny",
					value: yield* value("deny"),
					style: "danger" as const,
				},
			],
		}
	})

/**
 * Handles the work of all Channels: the events that came in, the messages that go out,
 * the end of each Turn, and the cards of requests.
 */
export const layer = (options: Options = {}) =>
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
			const settings = yield* Settings
			const { allows } = yield* Check.make
			const { resolveAsPerson } = yield* Resolve.make
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
					Effect.catch((error) =>
						Effect.logWarning(
							"The name of a member could not be read, so a message uses the user ID",
							error,
						).pipe(Effect.as(userId)),
					),
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
					// The link page is at the public origin now. Read it before the code is made,
					// so a failure makes no code. The event is then tried again later.
					const linkPage = yield* Option.match(
						Option.fromNullishOr(stored.linkPath),
						{
							onNone: () => Effect.succeedNone,
							onSome: (linkPath) =>
								Effect.map(Platform.publicOrigin(settings), (publicOrigin) =>
									Option.some(publicOrigin + linkPath),
								),
						},
					)
					const code = yield* channels.createLink({
						organizationId,
						channelId: stored.id,
						externalUserId: event.sender.externalId,
						displayName: event.sender.displayName,
					})
					const markdown = Option.match(linkPage, {
						onNone: () =>
							`Link your OpenBot account first. Accept this code in OpenBot within ${Duration.toMinutes(linkLifetimeMs)} minutes: \`${code}\``,
						onSome: (page) =>
							`Link your OpenBot account first: ${page}${Str.includes("?")(page) ? "&" : "?"}code=${encodeURIComponent(code)}`,
					})
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
					const bot = yield* bots.access(actor, stored.bot, "delegate")
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
				readonly chat: Chat.Id
				readonly events: Stream.Stream<ChatResponseSseEvent>
			}) => {
				const target = Target.Conversation({ conversation: input.conversation })
				/** Shows that the Turn runs, and keeps its message for the final answer. */
				const start = (turn: Turn.Id) =>
					Effect.gen(function* () {
						const ref = input.channel.features.edit
							? yield* input.channel.send(target, { markdown: working }).pipe(
									Effect.asSome,
									Effect.catch((error) =>
										Effect.logDebug(
											"A Channel could not show that a Turn runs.",
											error,
										).pipe(Effect.as(Option.none<MessageRef>())),
									),
								)
							: Option.none<MessageRef>()
						yield* queue.startReply({
							organizationId: input.organizationId,
							channelId: input.stored.id,
							target,
							chat: input.chat,
							turn,
							ref: Option.getOrNull(ref),
						})
						return ref
					})
				interface Shown {
					readonly started: boolean
					readonly ref: Option.Option<MessageRef>
					/** The text of the Turn so far. */
					readonly text: string
					/** When the message last changed. */
					readonly shown: number
				}
				return input.events.pipe(
					Stream.runFoldEffect(
						(): Shown => ({
							started: false,
							ref: Option.none(),
							text: "",
							shown: 0,
						}),
						(state, { data }) =>
							Effect.gen(function* () {
								const ref = state.started ? state.ref : yield* start(data.turn)
								const next: Shown = { ...state, started: true, ref }
								if (data.type !== "response.output_text.delta") return next
								const text = state.text + data.delta
								const now = yield* Clock.currentTimeMillis
								if (
									Option.isNone(ref) ||
									now - state.shown < editEveryMs ||
									text.length + 2 > input.channel.features.maxLength
								)
									return { ...next, text }
								yield* input.channel
									.edit(ref.value, { markdown: text + " …" })
									.pipe(
										Effect.ignore({
											log: "Debug",
											message: "A Channel could not change a running message.",
										}),
									)
								return { ...next, text, shown: now }
							}),
					),
					Background.logFailure("A Channel could not show a running Turn", {
						level: "Debug",
					}),
				)
			}

			/**
			 * Hands a message to its Chat. A message for a running Turn of the same person
			 * goes into it. A message of another person waits for its own Turn. The final
			 * answer of each Turn goes to the chat when the Turn ends. The live text of a new
			 * Turn shows in its own fiber until the Turn ends, so this step is done as soon
			 * as the Chat takes the message.
			 */
			const deliverMessage = (input: {
				readonly organizationId: string
				readonly stored: StoredChannel
				readonly chats: typeof Chats.Service
				readonly chat: Chat.Id
				readonly conversation: string
				readonly text: string
				readonly author: string
			}) =>
				Effect.gen(function* () {
					// The live text has its own scope. It is a child of the layer scope, so a
					// shut down closes it too, also when its fiber never starts.
					const turnScope = yield* Scope.fork(scope)
					const { live, result } = yield* Effect.all({
						// The live text holds its own borrow of the integration, because the
						// borrow of the event ends when the event is done.
						live: registry.get(input.organizationId, input.stored),
						result: input.chats.deliverStream(input.chat, {
							input: input.text,
							author: input.author,
						}),
					}).pipe(
						Scope.provide(turnScope),
						Effect.onError((cause) =>
							Scope.close(turnScope, Exit.failCause(cause)),
						),
					)
					if (Option.isNone(result.events))
						return yield* Scope.close(turnScope, Exit.void)
					yield* Effect.forkIn(
						follow({
							organizationId: input.organizationId,
							stored: input.stored,
							channel: live,
							conversation: input.conversation,
							chat: input.chat,
							events: result.events.value,
						}).pipe(Effect.ensuring(Scope.close(turnScope, Exit.void))),
						scope,
					)
				})

			/**
			 * Gets a message ready for its Chat. The result is the step that hands the
			 * message to the Chat, or nothing when the message does not go to a Chat.
			 */
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
					})
					const active = yield* organization.activeMember(
						organizationId,
						userId,
					)
					if (!allowed || Option.isNone(active)) {
						yield* tellSender(
							organizationId,
							stored,
							channel,
							event,
							"You may not use this Channel. Ask an administrator of your organization.",
						)
						return () => Effect.void
					}
					const found = yield* chatOf(organizationId, stored, event).pipe(
						Effect.asSome,
						Effect.catchTag(["BotNotFound", "Forbidden", "Pending"], (error) =>
							Effect.logInfo(
								"The actor of a Channel cannot give work to its Bot.",
								error,
							).pipe(
								Effect.as(Option.none()),
								Effect.annotateLogs({
									channel: stored.id,
									bot: stored.bot,
									actor: stored.actor,
								}),
							),
						),
					)
					if (Option.isNone(found)) {
						yield* tellSender(
							organizationId,
							stored,
							channel,
							event,
							"This Channel cannot work now: its actor cannot give work to its Bot. Ask an administrator to check the Channel.",
						)
						return () => Effect.void
					}
					const { chat, owner } = found.value
					const chats = yield* backend.forCaller({
						kind: "member",
						organizationId,
						userId: owner,
					})
					// In a group, the Bot must know who speaks.
					const text =
						event.conversation.kind === "group"
							? `${yield* nameOf(organizationId, userId)}: ${event.text}`
							: event.text
					return () =>
						deliverMessage({
							organizationId,
							stored,
							chats,
							chat,
							conversation: event.conversation.key,
							text,
							author: userId,
						})
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
					yield* channel.acknowledge(event).pipe(
						Effect.ignore({
							log: "Debug",
							message: "A Channel could not acknowledge a button.",
						}),
					)
					const button = readButton(event.value)
					if (Option.isNone(button)) return
					const { request, choice, revision } = button.value
					const caller: Caller = { kind: "member", organizationId, userId }
					const allowed = yield* allows(caller, {
						action: "resolve",
						resource: Authorization.Request.make({
							organizationId,
							ownerUserId: userId,
							id: request,
						}),
					})
					const answer = allowed
						? yield* resolveAsPerson(caller, request, {
								expected: revision,
								...decisions[choice],
							}).pipe(
								Effect.as(Option.none<string>()),
								Effect.catchTags({
									RequestNotFound: () =>
										Effect.succeedSome(
											"Only the person that the work is for can decide this request.",
										),
									RequestConflict: () =>
										Effect.succeedSome(
											"This request was already decided, or it changed.",
										),
								}),
							)
						: Option.some("You may not decide requests.")
					if (Option.isSome(answer))
						yield* tellSender(
							organizationId,
							stored,
							channel,
							event,
							answer.value,
						)
				})

			/**
			 * Handles an event up to the step that ends it, and gives back that step. Only
			 * a message that goes to a Chat has such a step. The integration of the Channel
			 * stays open until the scope of the event closes.
			 */
			const handleEvent = (claimed: ClaimedEvent) =>
				Effect.gen(function* () {
					const found = yield* channels.get(
						claimed.organizationId,
						claimed.channelId,
					)
					// A deleted or disabled Channel drops its events.
					if (Option.isNone(found) || !found.value.enabled)
						return () => Effect.void
					const stored = found.value
					const channel = yield* registry.get(claimed.organizationId, stored)
					const event = claimed.event
					if (
						event._tag === "Message" &&
						event.conversation.kind === "group" &&
						!event.mentioned
					)
						return () => Effect.void
					const identity = yield* channels.identity(
						stored.id,
						event.sender.externalId,
					)
					if (Option.isNone(identity)) {
						if (event._tag === "Action")
							yield* channel.acknowledge(event).pipe(
								Effect.ignore({
									log: "Debug",
									message: "A Channel could not acknowledge a button.",
								}),
							)
						yield* askToLink(claimed.organizationId, stored, channel, event)
						return () => Effect.void
					}
					const userId = identity.value.userId
					if (event._tag === "Message")
						return yield* onMessage(claimed, stored, channel, event, userId)
					yield* onAction(claimed, stored, channel, event, userId)
					return () => Effect.void
				})

			/**
			 * Puts a message back for a later try, and logs why. After too many tries, or
			 * when `give` is true, OpenBot gives up on the message.
			 */
			const retryDelivery = (
				delivery: Delivery,
				failure: unknown,
				delayMs: number | undefined,
				give: boolean,
			) =>
				queue.retryDelivery(delivery, delayMs, give).pipe(
					Effect.flatMap((gaveUp) =>
						gaveUp
							? Effect.logError(
									"OpenBot gave up on a Channel message.",
									failure,
								)
							: Effect.logWarning(
									"A Channel message did not go out. It is tried again later.",
									failure,
								),
					),
					// The log keeps the failure, also when the retry cannot be written. The
					// message then comes back when its lease ends.
					Effect.catch((error) =>
						Effect.logWarning(
							"A Channel message did not go out",
							failure,
							error,
						),
					),
				)

			/** Sends one message. A long text goes out in parts, and the first part changes the old message. */
			const deliver = (delivery: Delivery) =>
				// The integration of the Channel stays open until the message is out.
				Effect.scoped(
					// When the platform may have a part, only `finishDelivery` may end the
					// work. A stop between the two would send every part again after the
					// lease. So only the steps before the first send can stop.
					Effect.uninterruptibleMask((restore) =>
						Effect.gen(function* () {
							const found = yield* restore(
								channels.get(delivery.organizationId, delivery.channelId),
							)
							if (Option.isNone(found)) return
							const channel = yield* restore(
								registry.get(delivery.organizationId, found.value),
							)
							const parts = chunk(
								delivery.message.markdown,
								channel.features.maxLength,
							)
							const last = parts.length - 1
							const message = (text: string, index: number) => ({
								markdown: text,
								// Buttons go with the last part.
								...(index === last && delivery.message.buttons !== undefined
									? { buttons: delivery.message.buttons }
									: {}),
							})
							const first = message(Arr.headNonEmpty(parts), 0)
							const ref =
								delivery.ref !== null && channel.features.edit
									? yield* channel
											.edit(delivery.ref, first)
											.pipe(Effect.as(delivery.ref))
									: yield* channel.send(delivery.target, first)
							yield* Effect.forEach(
								Arr.tailNonEmpty(parts),
								(text, index) =>
									channel.send(
										Target.Conversation({ conversation: ref.conversation }),
										message(text, index + 1),
									),
								{ discard: true },
							)
							yield* queue.finishDelivery(delivery, ref)
						}),
					),
				).pipe(
					Effect.catchTag("ChannelDeliveryFailed", (failure) =>
						retryDelivery(
							delivery,
							failure,
							failure.retryAfterMs,
							!failure.retry,
						),
					),
				)

			/**
			 * Puts the final answer of a Turn in a chat of a Channel. The result is false
			 * when no chat of a Channel has the Chat now.
			 */
			const finishTurn = (input: {
				readonly organizationId: string
				readonly chat: Chat.Id
				readonly turn: Turn.Id
			}) =>
				Effect.gen(function* () {
					const conversation = yield* channels.conversationOfChat(input.chat)
					if (Option.isNone(conversation)) return false
					const chats = yield* backend.forCaller({
						kind: "member",
						organizationId: input.organizationId,
						userId: conversation.value.owner,
					})
					const result = yield* chats.turn(input.chat, input.turn)
					if (Turn.isTerminal(result.turn.status))
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
					return true
				})

			/** Ends a reply that can never get its answer, because its Chat or its Turn is gone. */
			const endReply = (
				reply: { readonly chat: Chat.Id; readonly turn: Turn.Id },
				reason: unknown,
			) =>
				Effect.logInfo(
					"The Chat of a Channel reply is gone, so OpenBot ends the reply.",
					reason,
				).pipe(Effect.andThen(queue.endReply(reply)))

			/**
			 * Where a request card goes: the direct chat of the approver, or the chat of the
			 * work. Only a request that a person decides gets a card.
			 */
			const cardTarget = (
				conversation: Conversation,
				request: RequestsApi.CapabilityRequest,
			) =>
				Effect.gen(function* () {
					const approver = request.approver
					if (approver._tag !== "Person") return Option.none<CardPlace>()
					const identity = yield* channels.identityOfUser(
						conversation.channelId,
						approver.userId,
					)
					return Option.some<CardPlace>(
						Option.match(identity, {
							onSome: (identity) => ({
								target: Target.Person({ person: identity.externalUserId }),
								approver: Option.none(),
							}),
							onNone: () => ({
								target: Target.Conversation({ conversation: conversation.key }),
								approver: Option.some(approver.userId),
							}),
						}),
					)
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
					if (Option.isNone(where)) return
					const bot = yield* bots.find(organizationId, request.bot)
					yield* queue.putRequest({
						organizationId,
						channelId: conversation.value.channelId,
						target: where.value.target,
						request: id,
						message: yield* requestCard(
							request,
							Option.match(bot, {
								onNone: () => "A Bot",
								onSome: (bot) => bot.name,
							}),
							yield* Effect.transposeOption(
								Option.map(where.value.approver, (approver) =>
									nameOf(organizationId, approver),
								),
							),
						),
					})
				})

			/** Follows one change. Its log lines name the Chat or the request. */
			const onSignal = (signal: Signal) => {
				switch (signal._tag) {
					case "TurnChanged":
						return signal.status === "Running"
							? Effect.void
							: finishTurn(signal).pipe(
									Background.logFailure("A Channel could not follow a change"),
									Effect.annotateLogs({
										organization: signal.organizationId,
										chat: signal.chat,
										turn: signal.turn,
									}),
								)
					case "RequestChanged":
						return onRequest(signal.organizationId, signal.request).pipe(
							Background.logFailure("A Channel could not follow a change"),
							Effect.annotateLogs({
								organization: signal.organizationId,
								request: signal.request,
							}),
						)
					default:
						return Effect.void
				}
			}

			const subscription = yield* PubSub.subscribe(signals.pubsub)
			yield* Stream.fromSubscription(subscription).pipe(
				Stream.runForEach((signal) => Effect.forkIn(onSignal(signal), scope)),
				Effect.forkScoped,
			)

			/**
			 * Puts an event that failed back for a later try, and logs why. After too many
			 * tries, OpenBot gives up on the event.
			 */
			const retryEvent = (entry: ClaimedEvent, cause: Cause.Cause<unknown>) =>
				queue.retryEvent(entry).pipe(
					Effect.flatMap((gaveUp) =>
						gaveUp
							? Effect.logError("OpenBot gave up on a Channel event.", cause)
							: Effect.logWarning(
									"A Channel event failed. It is tried again later.",
									cause,
								),
					),
					// The log keeps the failure, also when the retry cannot be written. The
					// event then comes back when its lease ends.
					Effect.catch((error) =>
						Effect.logWarning("A Channel event failed", cause, error),
					),
				)

			/**
			 * Works on the items of a claimed batch, four at a time, and renews their leases
			 * while the work runs. A batch can take longer than one lease, and another
			 * instance must not take its items then. The renewal stops with the batch.
			 */
			const whileClaimed = <I, E, R, ExtendError>(
				items: ReadonlyArray<I>,
				extend: (items: ReadonlyArray<I>) => Effect.Effect<void, ExtendError>,
				work: (item: I) => Effect.Effect<void, E, R>,
			) =>
				items.length === 0
					? Effect.void
					: Effect.scoped(
							Effect.gen(function* () {
								yield* Background.repeat(
									extend(items).pipe(Effect.delay(renewEvery)),
									{
										schedule: Schedule.forever,
										message: "A Channel lease could not be renewed",
									},
								)
								yield* Effect.forEach(items, work, {
									concurrency: 4,
									discard: true,
								})
							}),
						)

			// New events, one by one for each chat. Each event has its own failures, so one
			// event cannot stop the others.
			yield* Background.repeat(
				queue.claimEvents.pipe(
					Effect.flatMap((claimed) =>
						whileClaimed(claimed, queue.extendEvents, (entry) =>
							// The integration of the Channel stays open until the event is done.
							Effect.scoped(
								// Only the steps before the Chat may have the message can stop. A
								// stop after that would put the event back, and the message would
								// reach the Chat twice.
								Effect.uninterruptibleMask((restore) =>
									restore(handleEvent(entry)).pipe(
										Effect.flatMap((deliver) => deliver()),
										Effect.andThen(queue.finishEvent(entry)),
									),
								),
							).pipe(
								// A stop of the fiber of the event itself, such as at shut down,
								// goes past every handler of failures, but this finalizer still
								// runs. A stop is not a failed try, so the event goes back as it
								// was. A failure that comes with a stop counts as a try.
								Effect.onError((cause) =>
									Cause.hasInterruptsOnly(cause)
										? queue.releaseEvent(entry).pipe(
												Effect.ignore({
													log: "Debug",
													message:
														"A stopped Channel event could not be put back. It comes back when its lease ends.",
												}),
											)
										: Cause.hasInterrupts(cause)
											? retryEvent(entry, cause)
											: Effect.void,
								),
								Effect.catchCause((cause) =>
									Cause.hasInterrupts(cause)
										? Effect.void
										: retryEvent(entry, cause),
								),
								Effect.annotateLogs({
									organization: entry.organizationId,
									channel: entry.channelId,
									event: entry.event.eventId,
									attempts: entry.attempts + 1,
								}),
							),
						),
					),
				),
				{
					schedule: Schedule.spaced(interval),
					message: "The Channel inbox failed",
				},
			)
			// Messages that wait to go out. Each message has its own failures, so one
			// message cannot stop the others while they are sent.
			yield* Background.repeat(
				queue.claimDeliveries.pipe(
					Effect.flatMap((due) =>
						whileClaimed(due, queue.extendDeliveries, (delivery) =>
							deliver(delivery).pipe(
								// Any other failure counts as a try too, so a message that always
								// fails, such as one of a broken Channel, ends.
								Effect.catchCause((cause) =>
									Cause.hasInterruptsOnly(cause)
										? Effect.void
										: retryDelivery(delivery, cause, undefined, false),
								),
								Effect.annotateLogs({
									organization: delivery.organizationId,
									channel: delivery.channelId,
									delivery: delivery.id,
									attempts: delivery.attempts + 1,
								}),
							),
						),
					),
				),
				{
					schedule: Schedule.spaced(interval),
					message: "The Channel outbox failed",
				},
			)
			// A Turn that ended while no instance listened still gets its answer. A reply
			// whose Chat or Turn is gone can never get one, so it ends.
			yield* Background.repeat(
				queue.liveReplies.pipe(
					Effect.flatMap((live) =>
						Effect.forEach(
							live,
							(reply) =>
								finishTurn(reply).pipe(
									Effect.flatMap((found) =>
										found
											? Effect.void
											: endReply(
													reply,
													"No chat of a Channel has the Chat now.",
												),
									),
									Effect.catchTags({
										ChatNotFound: (error) => endReply(reply, error),
										ChatConflict: (error) => endReply(reply, error),
									}),
									// Other failures are often short, and the next check tries
									// again, so they are not warnings.
									Background.logFailure(
										"A Channel reply could not be finished",
										{ level: "Debug" },
									),
									Effect.annotateLogs({
										organization: reply.organizationId,
										channel: reply.channelId,
										chat: reply.chat,
										turn: reply.turn,
									}),
								),
							{ discard: true },
						),
					),
				),
				{
					schedule: Schedule.spaced(Duration.seconds(30)),
					message: "Channel replies could not be checked",
				},
			)
		}),
	)
