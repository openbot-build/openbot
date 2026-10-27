import * as PolicyOrigin from "./PolicyOrigin.ts"
import * as ToolOrigins from "../chats/ToolOrigins.ts"
import { Chat, Turn } from "@openbot-build/core"
import {
	Authorization,
	Bots as BotDomain,
	Caller,
	Execution,
	ExecutionIdentity,
	Requests as RequestDomain,
} from "@openbot-build/domain"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import * as Db from "../database/Database.ts"
import * as StoredChats from "../chats/StoredChats.ts"
import { TurnContext } from "../chats/TurnContext.ts"
import * as Check from "../authorization/Check.ts"
import { AuditLog } from "../audit/AuditLog.ts"
import * as ChatHost from "../chats/ChatHost.ts"
import { TurnAccess } from "../chats/TurnAccess.ts"
import { type Authorize, type DecisionCommand } from "../execution/Engine.ts"
import { Store, storage, type Key, type Fence } from "../execution/Store.ts"
import { Requests, Stored } from "./Requests.ts"

export const workflowName = "openbot.capability-request"
export const noticeWorkflowName = "openbot.request-notice"
export const decisionId = (request: RequestDomain.CapabilityRequest) =>
	`request:${request.revision}`
export const Continuation = Schema.Literals(["chat", "workflow"])
const Reference = Schema.Struct({
	source: Execution.Id,
	control: Schema.optionalKey(PolicyOrigin.Control),
	continuation: Continuation,
})
const TurnReference = Schema.Struct({ chat: Chat.Id })
const sameIdentity = Schema.toEquivalence(ExecutionIdentity)
const sameCaller = Schema.toEquivalence(Caller)
/** Data for the domain change stays in the sealed command record. */
export const Details = Schema.Struct({
	scope: Schema.optionalKey(BotDomain.GrantScope),
	reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000))),
	rule: Schema.optionalKey(
		Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000)),
	),
})

/** The saved Turn supplies identity and the Bot owner chain. */
export const Input = Schema.Struct({
	control: Schema.optionalKey(PolicyOrigin.Control),
	/** A workflow consumes its own result. Other requests send a Chat reply. */
	continuation: Continuation,
	capability: RequestDomain.CapabilityRequest.fields.capability,
	reason: Schema.String,
	toolCallId: Schema.String,
	app: RequestDomain.CapabilityRequest.fields.app,
	code: RequestDomain.CapabilityRequest.fields.code,
	call: Stored.fields.call,
	ask: Schema.optionalKey(
		Schema.Struct({
			person: Schema.optionalKey(Schema.Boolean),
			timeoutMs: Schema.optionalKey(
				Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
			),
			onExpire: RequestDomain.CapabilityRequest.fields.onExpire,
		}),
	),
})
export type Input = typeof Input.Type
/** A policy result is saved on first submit. It is not part of the command's identity. */
export interface PolicyDecision {
	readonly allow: boolean
	readonly by: BotDomain.Decider
	readonly reason?: string
}
export type End =
	| { readonly status: "completed" }
	| { readonly status: "cancelled"; readonly epoch: number }
	| { readonly status: "failed"; readonly failure: Execution.Failure }

const make = Effect.gen(function* () {
	const db = yield* Db.make
	const sql = yield* SqlClient.SqlClient
	const context = yield* TurnContext
	const store = yield* Store
	const requests = yield* Requests
	const access = yield* TurnAccess
	const origins = yield* ToolOrigins.make
	const policy = yield* PolicyOrigin.make
	const checks = yield* Check.make
	const audit = yield* AuditLog
	const sourceOf = Effect.fn("RequestCommands.sourceOf")(function* (
		key: Key,
		control?: PolicyOrigin.Control,
	) {
		if (control !== undefined) {
			const origin = yield* policy.limit(key, control)
			return {
				...origin,
				controlLimit: origin.limit,
				activeControl: origin.active,
				host: Option.some(origin.host),
			}
		}
		const execution = yield* store.loadMember(key)
		if (execution.record.resource.kind !== "Turn") {
			const origin = yield* origins.find(key)
			if (Option.isNone(origin)) return yield* Execution.Forbidden.make({})
			const { child } = origin.value
			return {
				execution,
				originKey: key,
				controlLimit: undefined,
				activeControl: true,
				chat: child.record.position.chat,
				turn: child.record.position.turn,
				host: Option.some(child.input.context.host),
			}
		}
		if (execution.record.resource.kind !== "Turn")
			return yield* Execution.Forbidden.make({})
		const reference = yield* Schema.decodeUnknownEffect(TurnReference)(
			execution.input,
		)
		return {
			execution,
			originKey: key,
			controlLimit: undefined,
			activeControl: true,
			chat: reference.chat,
			turn: Turn.Id.make(execution.record.resource.id),
			host: Option.none<ChatHost.ChatHostState>(),
		}
	}, storage)
	const load = Effect.fn("RequestCommands.load")(function* (key: Key) {
		const execution = yield* store.loadMember(key)
		if (
			execution.workflow !== workflowName ||
			execution.record.resource.kind !== "Request"
		)
			return yield* Execution.Forbidden.make({})
		const reference = yield* Schema.decodeUnknownEffect(Reference)(
			execution.input,
		)
		const sourceKey = { namespace: key.namespace, id: reference.source }
		const origin = yield* sourceOf(sourceKey, reference.control)
		const source = origin.execution
		const found = yield* requests.find(
			execution.identity.owner.organizationId,
			execution.record.resource.id,
		)
		if (Option.isNone(found))
			return yield* Execution.NotFound.make({ id: key.id })
		const stored = found.value
		if (
			stored.request.turn !== origin.turn ||
			stored.request.chat !== origin.chat ||
			stored.request.bot !== source.identity.botId ||
			stored.chain.organizationId !== source.identity.owner.organizationId ||
			ChatHost.ownerOf(stored.chain) !== source.identity.owner.userId ||
			stored.chain.userId !== source.identity.actor.userId ||
			stored.chain.tokenId !== source.identity.actor.tokenId ||
			!sameIdentity(execution.identity, {
				...source.identity,
				parentExecutionId: origin.originKey.id,
			})
		)
			return yield* Execution.Forbidden.make({})
		return {
			execution,
			sourceKey,
			originKey: origin.originKey,
			control: reference.control,
			stored,
			continuation: reference.continuation,
		}
	}, storage)
	const originFor = Effect.fn("RequestCommands.originFor")(function* (
		source: Key,
		input: Input,
	) {
		const origin = yield* sourceOf(source, input.control)
		if (input.control !== undefined) {
			if (!origin.activeControl)
				return yield* Execution.Conflict.make({ id: source.id })
			const execution = yield* store.get(source)
			if (
				input.continuation !== "workflow" ||
				input.call !== undefined ||
				input.capability.action !== "delegations.continue" ||
				input.capability.target !== execution.resource.id ||
				input.capability.arguments?.["limit"] !== origin.controlLimit ||
				input.toolCallId !== PolicyOrigin.controlId(source, input.control)
			)
				return yield* Execution.Forbidden.make({})
		}
		return origin
	}, storage)
	/** A resumed call uses its first request even when its policy now gives a new answer. */
	const submitted = Effect.fn("RequestCommands.submitted")(function* (
		source: Fence,
		commandKey: Execution.CommandKey,
		input: Input,
	) {
		const origin = yield* originFor(source, input)
		yield* access.authorize(
			origin.originKey,
			origin.execution.identity.actor,
			"replay",
		)
		const receipt = yield* store.receipt(source.namespace, commandKey, {
			actor: origin.execution.identity.actor,
			body: {
				source: source.id,
				input: yield* Schema.encodeEffect(Input)(input),
			},
		})
		if (Option.isNone(receipt))
			return Option.none<
				| { readonly _tag: "Allowed" }
				| {
						readonly _tag: "Requested"
						readonly stored: Stored
						readonly executionId: Execution.Id
				  }
			>()
		if (receipt.value.executionId === source.id)
			return Option.some({ _tag: "Allowed" as const })
		const saved = yield* load({
			namespace: source.namespace,
			id: receipt.value.executionId,
		})
		if (saved.sourceKey.id !== source.id)
			return yield* Execution.Conflict.make({ id: source.id })
		return Option.some({
			_tag: "Requested" as const,
			stored: saved.stored,
			executionId: saved.execution.record.id,
		})
	}, storage)

	/** Allow and request share one command key, so only one path can own a call. */
	const admit = Effect.fn("RequestCommands.admit")(function* (
		source: Fence,
		commandKey: Execution.CommandKey,
		input: Input,
	) {
		const origin = yield* originFor(source, input)
		yield* access.authorize(
			origin.originKey,
			origin.execution.identity.actor,
			"replay",
		)
		return yield* store.accept(
			source.namespace,
			commandKey,
			{
				actor: origin.execution.identity.actor,
				body: {
					source: source.id,
					input: yield* Schema.encodeEffect(Input)(input),
				},
			},
			() =>
				Effect.gen(function* () {
					yield* StoredChats.lock(db, source.namespace, origin.chat)
					yield* access.authorize(
						origin.originKey,
						origin.execution.identity.actor,
						input.control === undefined ? "advance" : "replay",
					)
					return yield* store.commit(
						source,
						{},
						Effect.gen(function* () {
							yield* originFor(source, input)
							return { executionId: source.id, start: false }
						}),
					)
				}),
		)
	}, storage)

	/** The command, request, call, execution and wake-up either all commit or all roll back. */
	const submit = Effect.fn("RequestCommands.submit")(function* (
		source: Fence,
		commandKey: Execution.CommandKey,
		input: Input,
		decided?: PolicyDecision,
	) {
		const origin = yield* originFor(source, input)
		const saved = origin.execution
		yield* access.authorize(origin.originKey, saved.identity.actor, "replay")
		const chat = origin.chat
		const body = {
			source: source.id,
			input: yield* Schema.encodeEffect(Input)(input),
		}
		return yield* store.accept(
			source.namespace,
			commandKey,
			{
				actor: saved.identity.actor,
				body,
			},
			(create) =>
				Effect.gen(function* () {
					yield* StoredChats.lock(db, source.namespace, chat)
					yield* access.authorize(
						origin.originKey,
						saved.identity.actor,
						input.control === undefined ? "advance" : "replay",
					)
					return yield* store.commit(
						source,
						{
							events: (child) => [
								{
									_tag: "ChildExecution",
									executionId: child.executionId,
									step: `request:${input.toolCallId}`,
								},
							],
						},
						Effect.gen(function* () {
							yield* originFor(source, input)
							const view = yield* StoredChats.ref(db, source.namespace, chat)
							if (
								Option.isNone(view) ||
								(Option.isNone(origin.host) &&
									(view.value.turn?.id !== origin.turn ||
										view.value.turn.status._tag !== "Running"))
							)
								return yield* Execution.Conflict.make({ id: source.id })
							const work = yield* context.prepare({
								identity: saved.identity,
								namespace: source.namespace,
								chat,
								host: Option.getOrElse(origin.host, () =>
									ChatHost.hostState(view.value),
								),
								turn: origin.turn,
							})
							const stored = yield* requests.create(
								saved.identity.owner.organizationId,
								{
									...input,
									...(decided === undefined ? {} : { decided }),
									bot: work.bot.id,
									chain: work.chain,
									deciders: work.deciders,
									chat,
									turn: work.turn,
								},
							)
							if (input.control !== undefined)
								yield* policy.linkRequest(
									source,
									input.control,
									stored.request.id,
								)
							const child = yield* create({
								workflow: workflowName,
								context: { kind: "Chat", id: chat },
								...(yield* store.ownership(origin.originKey)),
								resource: { kind: "Request", id: stored.request.id },
								identity: {
									...saved.identity,
									parentExecutionId: origin.originKey.id,
								},
								input: {
									source: source.id,
									continuation: input.continuation,
									...(input.control === undefined
										? {}
										: { control: input.control }),
								},
							})
							if (stored.request.status === "pending")
								yield* store.requestDecision(
									{ ...child, generation: 0 },
									decisionId(stored.request),
									["allow", "deny"],
								)
							return { executionId: child.id, start: true }
						}),
					)
				}),
		)
	}, storage)
	/** Caller keeps this lock through its next write. */
	const wake = (fence: Fence) =>
		Effect.gen(function* () {
			yield* store.lock(fence)
			const state = yield* store.loadMember(fence)
			if (
				state.generation !== fence.generation ||
				state.record.status === "cancelling" ||
				Execution.isTerminal(state.record.status)
			)
				return yield* Execution.Conflict.make({ id: fence.id })
			if (state.record.status === "waiting")
				yield* store.commit(fence, { status: "running" }, Effect.void)
		})
	/** A deadline changes the request under the execution fence. The workflow then ends it. */
	const expire = Effect.fn("RequestCommands.expire")(function* (fence: Fence) {
		return yield* sql.withTransaction(
			Effect.gen(function* () {
				yield* wake(fence)
				const before = (yield* load(fence)).stored
				if (
					before.request.status !== "pending" ||
					before.request.expiresAt > (yield* Clock.currentTimeMillis)
				)
					return before
				return yield* store.commit(
					fence,
					{
						events: (stored) => [
							{
								_tag: "Checkpoint",
								resource: { kind: "Request", id: stored.request.id },
								revision: stored.request.revision,
							},
						],
					},
					Effect.gen(function* () {
						const saved = yield* load(fence)
						yield* requests.expireOne(
							saved.execution.identity.owner.organizationId,
							saved.stored.request.id,
						)
						return (yield* load(fence)).stored
					}),
				)
			}),
		)
	}, storage)
	/** A review with no answer passes to the next decider under the same fence. */
	const pass = Effect.fn("RequestCommands.pass")(function* (
		fence: Fence,
		revision: number,
	) {
		return yield* sql.withTransaction(
			Effect.gen(function* () {
				yield* wake(fence)
				const saved = yield* load(fence)
				const request = saved.stored.request
				if (
					request.status !== "pending" ||
					request.revision !== revision ||
					request.approver._tag !== "Bot"
				)
					return
				const bot = request.approver.bot
				const changed = yield* store.commit(
					fence,
					{
						events: (changed) =>
							changed === undefined
								? []
								: [
										{
											_tag: "Checkpoint",
											resource: { kind: "Request", id: changed.request.id },
											revision: changed.request.revision,
										},
									],
					},
					requests
						.pass(
							saved.execution.identity.owner.organizationId,
							request.id,
							bot,
						)
						.pipe(Effect.map(Option.getOrUndefined)),
				)
				if (changed !== undefined)
					yield* store.requestDecision(fence, decisionId(changed.request), [
						"allow",
						"deny",
					])
			}),
		)
	}, storage)

	/** The waiting record and its decision are read under the same lock used by decide. */
	const waiting = Effect.fn("RequestCommands.waiting")(function* (
		fence: Fence,
	) {
		return yield* sql.withTransaction(
			Effect.gen(function* () {
				yield* store.lock(fence)
				const saved = yield* load(fence)
				if (
					saved.execution.generation !== fence.generation ||
					saved.execution.record.status === "cancelling" ||
					Execution.isTerminal(saved.execution.record.status)
				)
					return yield* Execution.Conflict.make({ id: fence.id })
				if (saved.stored.request.status !== "pending") return Option.none()
				yield* store.requestDecision(fence, decisionId(saved.stored.request), [
					"allow",
					"deny",
				])
				if (saved.execution.record.status !== "waiting")
					yield* store.commit(fence, { status: "waiting" }, Effect.void)
				return Option.some(saved.stored)
			}),
		)
	}, storage)
	/** Release reviews first. The final result and one durable notice then commit together. */
	const finish = Effect.fn("RequestCommands.finish")(function* (
		fence: Fence,
		end: End,
	) {
		const saved = yield* load(fence)
		return yield* store.accept(
			fence.namespace,
			Execution.CommandKey.make(
				`request-end:${fence.id}:${end.status === "cancelled" ? end.epoch : "result"}`,
			),
			{
				actor: saved.execution.identity.actor,
				body: end,
			},
			(create) =>
				Effect.gen(function* () {
					if (end.status !== "cancelled") yield* wake(fence)
					let notice: Option.Option<Key> = Option.none()
					const write = Effect.gen(function* () {
						if (end.status !== "completed")
							yield* requests.cancelOne(
								saved.execution.identity.owner.organizationId,
								saved.stored.request.id,
								end.status === "failed"
									? `The execution failed. Error ID: ${end.failure.errorId}`
									: undefined,
							)
						const current = yield* load(fence)
						if (current.stored.request.status === "pending")
							return yield* Execution.Conflict.make({ id: fence.id })
						yield* audit.record({
							organizationId: saved.execution.identity.owner.organizationId,
							actor: saved.execution.identity.actor,
							action: "request.resolved",
							resource: saved.stored.request.id,
							details: {
								executionId: fence.id,
								status: current.stored.request.status,
							},
						})
						// A cancelled request adds no Chat action. Keep any decision that was already committed.
						if (
							current.stored.request.status !== "cancelled" &&
							current.continuation === "chat"
						)
							notice = Option.some(
								yield* create({
									workflow: noticeWorkflowName,
									...(saved.execution.context === null
										? {}
										: { context: saved.execution.context }),
									...(yield* store.ownership(fence)),
									resource: {
										kind: "RequestNotice",
										id: current.stored.request.id,
									},
									identity: saved.execution.identity,
									input: { requestExecutionId: fence.id },
								}),
							)
						return [
							...Option.match(notice, {
								onNone: () => [],
								onSome: (key) => [
									{
										_tag: "ChildExecution" as const,
										executionId: key.id,
										step: "notice",
									},
								],
							}),
							{
								_tag: "Result" as const,
								resource: saved.execution.record.resource,
							},
						]
					})
					if (end.status === "cancelled")
						yield* store.finishCancellation(fence, end.epoch, () => write)
					else
						yield* store.commit(
							fence,
							{
								status: end.status,
								...(end.status === "failed" ? { failure: end.failure } : {}),
								events: (events) => events,
							},
							write,
						)
					return Option.match(notice, {
						onNone: () => ({ executionId: fence.id, start: false }),
						onSome: (key) => ({ executionId: key.id, start: true }),
					})
				}),
		)
	}, storage)

	const authorize: Authorize = (key, actor, mode) =>
		Effect.gen(function* () {
			const saved = yield* load(key)
			if (
				actor.organizationId !== saved.execution.identity.owner.organizationId
			)
				return yield* Execution.Forbidden.make({})
			if (mode === "advance" || mode === "replay") {
				if (!sameCaller(actor, saved.execution.identity.actor))
					return yield* Execution.Forbidden.make({})
				return yield* access.authorize(saved.originKey, actor, "replay")
			}
			// A person sees the requests of their own work, including a Channel speaker.
			if (actor.userId !== saved.stored.chain.userId)
				return yield* Execution.Forbidden.make({})
			yield* checks.check(actor, {
				action: "resolve",
				resource: Authorization.Request.make({
					organizationId: actor.organizationId,
					ownerUserId: saved.stored.chain.userId,
					id: saved.stored.request.id,
				}),
			})
			if (mode === "decide") {
				const approver = saved.stored.request.approver
				if (approver._tag !== "Person" || approver.userId !== actor.userId)
					return yield* Execution.Forbidden.make({})
				yield* access.authorize(
					saved.originKey,
					saved.execution.identity.actor,
					"replay",
				)
			}
		}).pipe(
			Effect.catchTags({
				Forbidden: () => Effect.fail(Execution.Forbidden.make({})),
				Pending: () => Effect.fail(Execution.Forbidden.make({})),
			}),
			storage,
		)
	const decide = Effect.fn("RequestCommands.decide")(function* (
		key: Key,
		actor: Caller,
		input: DecisionCommand & { readonly details?: typeof Details.Type },
	) {
		yield* authorize(key, actor, "decide")
		if (input.answer !== "allow" && input.answer !== "deny")
			return yield* Execution.Conflict.make({ id: key.id })
		const details = yield* Schema.decodeEffect(Details)(input.details ?? {})
		return yield* store.decide(
			key,
			input.commandKey,
			input.decisionId,
			input.answer,
			actor,
			{
				input: yield* Schema.encodeEffect(Details)(details),
				apply: Effect.gen(function* () {
					// Recheck inside the decision transaction before writing Grants or Rules.
					yield* authorize(key, actor, "decide")
					const { stored } = yield* load(key)
					if (input.decisionId !== decisionId(stored.request))
						return yield* Execution.Conflict.make({ id: key.id })
					yield* requests.decide(actor.organizationId, stored.request.id, {
						by: { _tag: "Person", userId: actor.userId },
						allow: input.answer === "allow",
						expected: stored.request.revision,
						...details,
					})
					yield* audit.record({
						organizationId: actor.organizationId,
						action: "capability.decided",
						actor,
						resource: stored.request.id,
						details: {
							executionId: key.id,
							decision: input.answer,
							...(details.scope === undefined ? {} : { scope: details.scope }),
						},
					})
				}).pipe(
					Effect.catchTags({
						RequestConflict: () =>
							Effect.fail(Execution.Conflict.make({ id: key.id })),
						RequestNotFound: () =>
							Effect.fail(Execution.NotFound.make({ id: key.id })),
					}),
				),
			},
		)
	}, storage)
	return {
		admit,
		submit,
		submitted,
		load,
		waiting,
		expire,
		pass,
		finish,
		authorize,
		decide,
	}
})
export class RequestCommands extends Context.Service<
	RequestCommands,
	Effect.Success<typeof make>
>()("@openbot-build/openbot/capabilities/RequestCommands") {}
export const layer = Layer.effect(RequestCommands, make)
