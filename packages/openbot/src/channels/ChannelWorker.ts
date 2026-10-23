import type { Caller, RequestsApi } from "@openbot-build/api"
import { Session, Turn } from "@openbot-build/core"
import type { SessionResponseSseEvent } from "@openbot-build/api"
import {
	Clock,
	Deferred,
	Duration,
	Effect,
	Fiber,
	Layer,
	Option,
	PubSub,
	Schedule,
	Stream,
} from "effect"
import { Agents } from "../agents/Agents.ts"
import { Signals, type Signal } from "../agents/Signals.ts"
import { Backend } from "../app/Backend.ts"
import { can } from "../authorization/Check.ts"
import { resourceKey } from "../authorization/Policy.ts"
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
			`The Agent could not finish: ${response.error?.message ?? "unknown error"}`
		)
	if (response.status === "cancelled")
		return (text.length > 0 ? text + "\n\n" : "") + "The Agent stopped."
	return text.length > 0 ? text : "The Agent did not write an answer."
}

const decisions = {
	once: { decision: "allow", scope: "once" },
	session: { decision: "allow", scope: "session" },
	deny: { decision: "deny" },
} as const
type Choice = keyof typeof decisions

/** The value of an approval button: the request, the choice and the revision it saw. */
const buttonValue = (request: string, choice: Choice, revision: number) =>
	`${request} ${choice} ${revision}`

const readButton = (value: string) => {
	const [request, choice, revision] = value.split(" ")
	if (
		request === undefined ||
		choice === undefined ||
		!(choice in decisions) ||
		revision === undefined ||
		!/^\d+$/.test(revision)
	)
		return undefined
	return { request, choice: choice as Choice, revision: Number(revision) }
}

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
		default:
			return `do \`${action}\` on \`${target}\``
	}
}

const outcome = (request: RequestsApi.CapabilityRequest) => {
	switch (request.status) {
		case "pending":
			return "Waiting for a decision."
		case "allowed":
			return request.decision?.scope === "session"
				? "Allowed for this Session."
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
	agentName: string,
	approverName: string | null,
): OutboundMessage => ({
	markdown: [
		`**${agentName}** wants to ${describe(request)}.`,
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
						label: "Allow for this Session",
						value: buttonValue(request.id, "session", request.revision),
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
			const agents = yield* Agents
			const organization = yield* Organization
			const requests = yield* Requests
			const signals = yield* Signals
			const services = yield* Effect.context<
				| Effect.Services<ReturnType<typeof resolveAsPerson>>
				| Effect.Services<ReturnType<typeof can>>
				| Effect.Services<ReturnType<typeof agents.access>>
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

			/** The Session of a chat. A new chat gets a new Session of the actor of the Channel. */
			const sessionOf = (
				organizationId: string,
				stored: StoredChannel,
				event: ChannelEvent,
			) =>
				Effect.gen(function* () {
					const found = yield* channels.conversation(
						stored.id,
						event.conversation.key,
					)
					if (Option.isSome(found))
						return {
							session: found.value.session as Session.Id,
							owner: found.value.owner,
						}
					const actor: Caller = {
						kind: "member",
						organizationId,
						userId: stored.actor,
					}
					const agent = yield* agents
						.access(actor, stored.agent, "agents.delegate")
						.pipe(Effect.provideContext(services))
					const sessions = yield* backend.forCaller(actor)
					const title =
						event.conversation.title ??
						(event.conversation.kind === "direct"
							? `${stored.name}: ${event.sender.displayName}`
							: stored.name)
					const created = yield* sessions.create({
						agent,
						kind: "channel",
						chain: {
							organizationId,
							userId: stored.actor,
							agents: [agent.id],
							sessions: [],
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
						session: created.session.id,
						owner: stored.actor,
					})
					return { session: created.session.id, owner: stored.actor }
				})

			/** Shows the text of a running Turn in its message, at most once each 1.5 seconds. */
			const follow = (input: {
				readonly organizationId: string
				readonly stored: StoredChannel
				readonly channel: Channel
				readonly conversation: string
				readonly session: string
				readonly events: Stream.Stream<SessionResponseSseEvent>
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
										session: input.session,
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
					const allowed = yield* can({
						caller,
						permission: "channels.use",
						key: resourceKey({
							subject: caller,
							kind: "channel",
							id: Option.some(stored.id),
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
					const chat = yield* sessionOf(organizationId, stored, event).pipe(
						Effect.catchTag(["AgentNotFound", "PermissionDenied"], () =>
							Effect.succeed(null),
						),
					)
					if (chat === null)
						return yield* tellSender(
							organizationId,
							stored,
							channel,
							event,
							"This Channel cannot work now: its actor cannot give work to its Agent. Ask an administrator to check the Channel.",
						)
					const { session, owner } = chat
					const sessions = yield* backend.forCaller({
						kind: "member",
						organizationId,
						userId: owner,
					})
					// In a group, the Agent must know who speaks.
					const input =
						event.conversation.kind === "group"
							? `${yield* nameOf(organizationId, userId)}: ${event.text}`
							: event.text
					// The queued message runs after the current Turn, as its own Turn.
					const enqueue = sessions
						.enqueue(session, { input, author: userId })
						.pipe(Effect.asVoid)
					const view = yield* sessions.get(session)
					const current = Session.currentTurn(view.session)
					if (current !== undefined && !Turn.isTerminal(current.status))
						return yield* enqueue
					// The stream lives in its own fiber until the Turn ends. This event is done
					// as soon as the Session takes the Turn.
					const accepted = yield* Deferred.make<boolean>()
					const run = Effect.scoped(
						Effect.gen(function* () {
							const events = yield* sessions.sendStream(session, {
								expected: view.session.revision,
								input,
								author: userId,
							})
							yield* Deferred.succeed(accepted, true)
							yield* follow({
								organizationId,
								stored,
								channel,
								conversation: event.conversation.key,
								session,
								events,
							})
						}),
					).pipe(
						Effect.catchTags({
							// Another message started a Turn first. This one waits after it.
							SessionBusy: () => enqueue,
							SessionConflict: () => enqueue,
						}),
						Effect.onExit(() => Deferred.succeed(accepted, false)),
					)
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
					const allowed = yield* can({
						caller,
						permission: "requests.resolve",
						key: resourceKey({
							subject: caller,
							kind: "request",
							id: Option.some(button.request),
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
				readonly session: string
				readonly turn: string
			}) =>
				Effect.gen(function* () {
					const conversation = yield* channels.conversationOfSession(
						input.session,
					)
					if (Option.isNone(conversation)) return
					const sessions = yield* backend.forCaller({
						kind: "member",
						organizationId: input.organizationId,
						userId: conversation.value.owner,
					})
					const result = yield* sessions.turn(
						input.session as Session.Id,
						input.turn as Turn.Id,
					)
					if (!Turn.isTerminal(result.turn.status)) return
					yield* queue.finishReply({
						organizationId: input.organizationId,
						channelId: conversation.value.channelId,
						target: Target.Conversation({
							conversation: conversation.value.key,
						}),
						session: input.session,
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
					// The work may run in a Session below the chat, such as a delegated one.
					let conversation = Option.none<Conversation>()
					for (const session of [request.session, ...chain.sessions].reverse())
						if (Option.isNone(conversation))
							conversation = yield* channels.conversationOfSession(session)
					if (Option.isNone(conversation)) return
					const known =
						(yield* queue.requestRef(conversation.value.channelId, id)) !== null
					if (request.status !== "pending" && !known) return
					const where = yield* cardTarget(conversation.value, request)
					if (where.target === null) return
					const agent = yield* agents.find(organizationId, request.agent)
					yield* queue.putRequest({
						organizationId,
						channelId: conversation.value.channelId,
						target: where.target,
						request: id,
						message: requestCard(
							request,
							Option.match(agent, {
								onNone: () => "An Agent",
								onSome: (agent) => agent.name,
							}),
							where.approver === null
								? null
								: yield* nameOf(organizationId, where.approver),
						),
					})
				})

			const onSignal = (signal: Signal) =>
				Effect.gen(function* () {
					if (
						signal._tag === "TurnChanged" &&
						signal.status !== "Running" &&
						signal.status !== "Waiting"
					)
						yield* finishTurn({
							organizationId: signal.organizationId,
							session: signal.session,
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
								Effect.catchCause((cause) =>
									Effect.logWarning(
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
