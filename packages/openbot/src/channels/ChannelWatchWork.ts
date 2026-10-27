import { Turn } from "@openbot-build/core"
import { Execution } from "@openbot-build/domain"
import { Array as Arr, Effect, Option, Ref, Schema, Stream } from "effect"
import { Bots } from "../bots/Bots.ts"
import { Requests } from "../capabilities/Requests.ts"
import * as ChatRecords from "../chats/ChatRecords.ts"
import { Registry } from "../execution/Engine.ts"
import { inExecution } from "../chats/ChatEncoding.ts"
import { Store, type Fence } from "../execution/Store.ts"
import { Observation } from "../execution/Observation.ts"
import type { Authorize } from "../execution/Engine.ts"
import { Organization } from "../organization/Organization.ts"
import { ChannelWatch } from "./ChannelWatch.ts"
import * as ChannelSend from "./ChannelSend.ts"
import { Channels } from "./Channels.ts"
import { ChannelRegistry } from "./ChannelRegistry.ts"
import { ChannelQueue } from "./ChannelQueue.ts"
import { MessageRef, Target } from "./Channel.ts"
import * as ChannelAccess from "./ChannelAccess.ts"
import { requestCard } from "./ChannelMessages.ts"

export const make = Effect.gen(function* () {
	const watches = yield* ChannelWatch
	const store = yield* Store
	const records = yield* ChatRecords.make
	const observation = yield* Observation
	const channels = yield* Channels
	const registry = yield* ChannelRegistry
	const sends = yield* ChannelSend.make
	const queue = yield* ChannelQueue
	const requests = yield* Requests
	const bots = yield* Bots
	const organization = yield* Organization
	const workflows = yield* Registry
	const channelAccess = yield* ChannelAccess.make
	const authorize: Authorize = (key, actor, mode) =>
		channelAccess(key, actor, mode).pipe(
			Effect.andThen(
				Effect.gen(function* () {
					const { input, execution } = yield* watches.load(key)
					if (mode === "advance" || mode === "replay") {
						const source = {
							namespace: key.namespace,
							id: input.sourceExecutionId,
						}
						const parent = yield* store.loadMember(source)
						const feature = yield* workflows.get(parent.workflow)
						if (Option.isNone(feature))
							return yield* Execution.Forbidden.make({})
						yield* feature.value.authorize(
							source,
							execution.identity.actor,
							"replay",
						)
					}
				}),
			),
		)
	const handle = (fence: Fence) =>
		Effect.gen(function* () {
			const { input, execution } = yield* watches.load(fence)
			yield* authorize(fence, execution.identity.actor, "advance")
			const source = { namespace: fence.namespace, id: input.sourceExecutionId }
			const parent = yield* store.loadMember(source)
			const organizationId = execution.identity.owner.organizationId
			const found = yield* channels.get(organizationId, input.channelId)
			if (Option.isNone(found)) return yield* Execution.Forbidden.make({})
			const channel = yield* registry.get(organizationId, found.value.id)
			const target = Target.Conversation({ conversation: input.conversation })
			let ref = Option.none<MessageRef>()
			if (input.reply && channel.features.edit) {
				ref = yield* sends.send(fence, channel, "working", target, {
					markdown: "Working…",
				})
				if (Option.isNone(ref)) return false
			}
			const activeRef = yield* Ref.make(ref)
			const stopped = yield* Ref.make(false)
			let text = ""
			let shown = 0
			let step = ""
			let attempt = 0
			const onEvent = (event: Execution.Event) =>
				Effect.gen(function* () {
					yield* authorize(fence, execution.identity.actor, "advance")
					const body = event.body
					if (body._tag === "ChildExecution" || body._tag === "InputMoved") {
						const child = yield* store.loadMember({
							namespace: fence.namespace,
							id: body.executionId,
						})
						const place = Schema.decodeUnknownOption(
							Schema.Struct({ chat: Schema.String }),
						)(child.input)
						yield* store.commit(
							fence,
							{},
							watches.start(fence.namespace, {
								...input,
								sourceExecutionId: body.executionId,
								reply:
									child.record.resource.kind === "Turn" &&
									Option.exists(place, (place) => place.chat === input.chat),
							}),
						)
					}
					if (
						parent.record.resource.kind === "Request" &&
						(body._tag === "State" ||
							body._tag === "Checkpoint" ||
							body._tag === "DecisionMade")
					) {
						const found = yield* requests.find(
							organizationId,
							parent.record.resource.id,
						)
						if (
							Option.isSome(found) &&
							found.value.request.approver._tag === "Person"
						) {
							const request = found.value.request
							const approver = found.value.request.approver.userId
							const identity = yield* channels.identityOfUser(
								input.channelId,
								approver,
							)
							const member = yield* organization.member(
								organizationId,
								approver,
							)
							const bot = yield* bots.find(organizationId, request.bot)
							const message = yield* requestCard(
								request,
								Option.match(bot, {
									onNone: () => "A Bot",
									onSome: (bot) => bot.name,
								}),
								Option.isSome(identity)
									? Option.none()
									: Option.some(
											Option.match(member, {
												onNone: () => approver,
												onSome: (member) =>
													member.name ?? member.email ?? approver,
											}),
										),
							)
							yield* store.accept(
								fence.namespace,
								Execution.CommandKey.make(
									"channel-card:" +
										fence.id +
										":" +
										request.revision +
										":" +
										request.status,
								),
								{
									actor: execution.identity.actor,
									body: {
										request: request.id,
										revision: request.revision,
										status: request.status,
									},
								},
								() =>
									store.commit(
										fence,
										{},
										queue
											.putRequest(
												fence,
												"card:" + request.revision + ":" + request.status,
												{
													channelId: input.channelId,
													target: Option.isSome(identity)
														? Target.Person({
																person: identity.value.externalUserId,
															})
														: target,
													request: request.id,
													message,
												},
											)
											.pipe(Effect.as({ executionId: fence.id, start: false })),
									),
							)
						}
					}
					if (!input.reply) return true
					if (body._tag === "StepStarted") {
						if (body.step === step && body.attempt !== attempt) text = ""
						step = body.step
						attempt = body.attempt
					}
					if (body._tag === "Text") {
						text += body.text
						const ref = yield* Ref.get(activeRef)
						if (
							Option.isSome(ref) &&
							event.createdAt - shown >= 1500 &&
							text.length + 2 <= channel.features.maxLength
						) {
							const sent = yield* sends.send(
								fence,
								channel,
								"text:" + event.sequence,
								target,
								{ markdown: text + " …" },
								ref.value,
							)
							if (Option.isNone(sent)) return false
							shown = event.createdAt
						}
					}
					if (body._tag === "State" && Execution.isTerminal(body.status)) {
						const items = yield* records(fence.namespace).turnLog(
							input.chat,
							Turn.Id.make(parent.record.resource.id),
						)
						const parts = Arr.flatMap(items, (item) =>
							Arr.flatMap(item.content.content, (message) =>
								message.role === "assistant"
									? Arr.flatMap(message.content, (part) =>
											part.type === "text" ? [part.text] : [],
										)
									: [],
							),
						)
						const answer = Arr.join(parts, "")
						const markdown =
							body.status === "failed"
								? (answer.length === 0 ? "" : answer + "\n\n") +
									"The Bot could not finish. Error ID: " +
									(body.failure?.errorId ?? "unknown")
								: body.status === "cancelled" || body.status === "interrupted"
									? (answer.length === 0 ? "" : answer + "\n\n") +
										"The Bot stopped."
									: answer.length > 0
										? answer
										: "The Bot did not write an answer."
						const sent = yield* sends.send(
							fence,
							channel,
							"answer",
							target,
							{ markdown },
							Option.getOrNull(yield* Ref.get(activeRef)),
						)
						if (Option.isNone(sent)) return false
					}
					return true
				})
			yield* observation.observe(source, 0).pipe(
				Stream.mapEffect(onEvent),
				Stream.tap((next) => (next ? Effect.void : Ref.set(stopped, true))),
				Stream.takeUntil((next) => !next),
				Stream.runDrain,
			)
			return !(yield* Ref.get(stopped))
		}).pipe(
			Effect.scoped,
			Effect.flatMap((done) =>
				done ? watches.finish(fence, { status: "completed" }) : Effect.void,
			),
			inExecution,
		)

	return { handle, authorize }
})
