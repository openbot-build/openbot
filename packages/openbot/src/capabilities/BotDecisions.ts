import { and, eq } from "drizzle-orm"
import { executions } from "../database/ExecutionSchema.ts"
import { Chat } from "@openbot-build/core"
import { Bots as BotDomain, Caller, Execution } from "@openbot-build/domain"
import {
	Array as Arr,
	Clock,
	Context,
	Crypto,
	Effect,
	Layer,
	Option,
	Schema,
} from "effect"
import { AuditLog } from "../audit/AuditLog.ts"
import { Bots } from "../bots/Bots.ts"
import * as ChatHost from "../chats/ChatHost.ts"
import * as StoredChats from "../chats/StoredChats.ts"
import { workflowName as turnWorkflow } from "../chats/InputCommands.ts"
import { TurnAccess } from "../chats/TurnAccess.ts"
import * as Db from "../database/Database.ts"
import { Store, storage, type Fence, type Key } from "../execution/Store.ts"
import { hash } from "./Capability.ts"
import { CapabilityAccess } from "./CapabilityAccess.ts"
import { RequestCommands, decisionId, workflowName } from "./RequestCommands.ts"
import { Rules } from "./Rules.ts"
import { Requests, chatOf } from "./Requests.ts"

export const Decision = Schema.Struct({
	allow: Schema.Boolean,
	scope: Schema.optionalKey(BotDomain.GrantScope),
	reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000))),
	question: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4000))),
	endorseOnly: Schema.optionalKey(Schema.Boolean),
})
export const Proposal = Schema.Struct({
	text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000)),
})
const Reference = Schema.Struct({ chat: Chat.Id })
const sameCaller = Schema.toEquivalence(Caller)
export interface Service {
	readonly forReview: (
		review: Fence,
	) => Effect.Effect<
		{ namespace: string; id: Execution.Id },
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.NotFound
		| Execution.StorageError
	>
	readonly decide: (
		key: Key,
		review: Fence,
		commandKey: Execution.CommandKey,
		input: typeof Decision.Type,
	) => Effect.Effect<
		{ receipt: Execution.Receipt; outcome: "allowed" | "denied" | "passed" },
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.KeyConflict
		| Execution.NotFound
		| Execution.StorageError
	>
	readonly propose: (
		key: Key,
		review: Fence,
		commandKey: Execution.CommandKey,
		input: { readonly text: string },
	) => Effect.Effect<
		{ receipt: Execution.Receipt; ruleId: BotDomain.RuleId },
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.KeyConflict
		| Execution.NotFound
		| Execution.StorageError
	>
	readonly readDecision: (
		key: Key,
		review: Fence,
		commandKey: Execution.CommandKey,
		input: typeof Decision.Type,
	) => Effect.Effect<
		| Option.None<{
				receipt: Execution.Receipt
				outcome: "allowed" | "denied" | "passed"
		  }>
		| Option.Some<{
				receipt: Execution.Receipt
				outcome: "allowed" | "denied" | "passed"
		  }>,
		| Execution.Forbidden
		| Execution.KeyConflict
		| Execution.NotFound
		| Execution.StorageError
	>
	readonly readProposal: (
		key: Key,
		review: Fence,
		commandKey: Execution.CommandKey,
		input: { readonly text: string },
	) => Effect.Effect<
		| Option.None<{ receipt: Execution.Receipt; ruleId: BotDomain.RuleId }>
		| Option.Some<{ receipt: Execution.Receipt; ruleId: BotDomain.RuleId }>,
		| Execution.Forbidden
		| Execution.KeyConflict
		| Execution.NotFound
		| Execution.StorageError
	>
}

export class BotDecisions extends Context.Service<BotDecisions, Service>()(
	"@openbot-build/openbot/capabilities/BotDecisions",
) {}

export const make = Effect.gen(function* () {
	const db = yield* Db.make
	const store = yield* Store
	const crypto = yield* Crypto.Crypto
	const commands = yield* RequestCommands
	const requests = yield* Requests
	const rules = yield* Rules
	const access = yield* TurnAccess
	const capabilities = yield* CapabilityAccess
	const bots = yield* Bots
	const audit = yield* AuditLog
	const load = Effect.fn("BotDecisions.load")(function* (
		key: Key,
		review: Key,
	) {
		const saved = yield* commands.load(key)
		const child = yield* store.loadMember(review)
		const ref = yield* Schema.decodeUnknownEffect(Reference)(child.input)
		const chat = yield* StoredChats.ref(db, review.namespace, ref.chat)
		if (Option.isNone(chat)) return yield* Execution.Forbidden.make({})
		const host = ChatHost.hostState(chat.value)
		if (
			child.workflow !== turnWorkflow ||
			child.record.resource.kind !== "Turn" ||
			host.kind !== "review" ||
			host.review !== saved.stored.request.id ||
			child.identity.parentExecutionId !== saved.originKey.id ||
			child.identity.botId !== host.bot ||
			child.identity.owner.organizationId !==
				saved.execution.identity.owner.organizationId ||
			child.identity.owner.userId !== saved.stored.chain.userId ||
			!sameCaller(child.identity.actor, saved.execution.identity.actor)
		)
			return yield* Execution.Forbidden.make({})
		return { ...saved, child, chat: chat.value, host }
	}, storage)
	/** Resolve the request from saved review data. The model cannot choose another request. */
	const forReview = Effect.fn("BotDecisions.forReview")(function* (
		review: Fence,
	) {
		const child = yield* store.loadMember(review)
		yield* access.authorize(review, child.identity.actor, "replay")
		const ref = yield* Schema.decodeUnknownEffect(Reference)(child.input)
		const chat = yield* StoredChats.ref(db, review.namespace, ref.chat)
		if (Option.isNone(chat) || child.identity.parentExecutionId === undefined)
			return yield* Execution.Forbidden.make({})
		const host = ChatHost.hostState(chat.value)
		if (host.kind !== "review" || host.review === undefined)
			return yield* Execution.Forbidden.make({})
		const source = yield* store.locate(
			child.identity.parentExecutionId,
			child.identity.owner.organizationId,
		)
		const found = yield* db
			.select({ id: executions.id })
			.from(executions)
			.where(
				and(
					eq(executions.namespace, source.namespace),
					eq(executions.workflow, workflowName),
					eq(executions.resourceKind, "Request"),
					eq(executions.resourceId, host.review),
				),
			)
			.limit(2)
		if (found.length !== 1)
			return yield* Execution.Conflict.make({ id: review.id })
		const key = {
			namespace: source.namespace,
			id: Execution.Id.make(found[0]!.id),
		}
		yield* load(key, review)
		return key
	}, storage)
	/** Match the saved child link, not a Bot ID alone: an old review cannot decide a new revision. */
	const bound = Effect.fn("BotDecisions.bound")(function* (
		key: Key,
		review: Key,
	) {
		const saved = yield* load(key, review)
		const request = saved.stored.request
		if (
			saved.host.closed === true ||
			request.status !== "pending" ||
			request.expiresAt <= (yield* Clock.currentTimeMillis) ||
			request.approver._tag !== "Bot" ||
			request.approver.bot !== saved.host.bot
		)
			return yield* Execution.Conflict.make({ id: key.id })
		let cursor = 0
		let linked = false
		while (true) {
			const events = yield* store.events(key, cursor)
			for (const event of events) {
				if (
					event.body._tag !== "ChildExecution" ||
					event.body.step !== `review:${request.revision}`
				)
					continue
				const firstKey = yield* store.locate(
					event.body.executionId,
					saved.execution.identity.owner.organizationId,
				)
				const first = yield* store.loadMember(firstKey)
				const ref = yield* Schema.decodeUnknownEffect(Reference)(first.input)
				if (
					firstKey.namespace === review.namespace &&
					ref.chat === saved.chat.id
				)
					linked = true
			}
			if (events.length < 128) break
			const last = Arr.last(events)
			if (Option.isNone(last)) break
			cursor = last.value.sequence
		}
		if (!linked) return yield* Execution.Forbidden.make({})
		const bot = yield* bots.find(
			saved.execution.identity.owner.organizationId,
			saved.host.bot,
		)
		if (Option.isNone(bot) || bot.value.archived)
			return yield* Execution.Forbidden.make({})
		return {
			...saved,
			bot: bot.value,
			holdingInput: {
				organizationId: saved.execution.identity.owner.organizationId,
				bot: bot.value,
				capability: request.capability,
				chat: chatOf({
					chain: saved.stored.chain,
					bot: bot.value.id,
					current: request.chat,
				}),
			},
		}
	}, storage)
	const decide = Effect.fn("BotDecisions.decide")(function* (
		key: Key,
		review: Fence,
		commandKey: Execution.CommandKey,
		input: typeof Decision.Type,
	) {
		const saved = yield* load(key, review)
		const actor = saved.child.identity.actor
		yield* access.authorize(review, actor, "replay")
		yield* commands.authorize(key, actor, "replay")
		const body = {
			requestExecutionId: key.id,
			reviewExecutionId: review.id,
			decision: yield* Schema.encodeEffect(Decision)(input),
		}
		const command = { actor, body }
		const prior = yield* store.receipt(review.namespace, commandKey, command)
		const outcome = (receipt: Execution.Receipt) =>
			commands.load(key).pipe(
				Effect.map(({ stored }) => ({
					receipt,
					outcome:
						input.allow &&
						Arr.some(
							stored.request.endorsements,
							(entry) => entry.bot === saved.host.bot,
						)
							? ("passed" as const)
							: input.allow
								? ("allowed" as const)
								: ("denied" as const),
				})),
			)
		if (Option.isSome(prior)) return yield* outcome(prior.value)
		const apply = Effect.gen(function* () {
			const before = yield* bound(key, review)
			yield* access.authorize(review, actor, "advance")
			// A rule model may do I/O. Only its checked evidence goes into the transaction below.
			const proof =
				input.allow && input.endorseOnly !== true
					? yield* capabilities.holding(before.holdingInput)
					: Option.none()
			const answerKey = Execution.CommandKey.make(
				`review-answer:${yield* hash(crypto, [review.id, commandKey])}`,
			)
			const receipt = yield* store.accept(
				review.namespace,
				commandKey,
				command,
				() =>
					Effect.gen(function* () {
						yield* store.decide(
							key,
							answerKey,
							decisionId(before.stored.request),
							input.allow ? "allow" : "deny",
							actor,
							{
								input: body,
								apply: Effect.gen(function* () {
									// The request row is already locked. Release takes the same request, Chat, Turn order.
									yield* StoredChats.lock(db, review.namespace, saved.chat.id)
									yield* store.lock(review)
									const current = yield* bound(key, review)
									if (
										current.stored.request.revision !==
										before.stored.request.revision
									)
										return yield* Execution.Conflict.make({ id: key.id })
									yield* access.authorize(review, actor, "advance")
									yield* commands.authorize(key, actor, "advance")
									const holds = yield* capabilities.stillHolds(
										current.holdingInput,
										proof,
									)
									yield* store.commit(
										review,
										{
											events: (answer) => [
												{
													_tag: "Checkpoint",
													resource: {
														kind: "Request",
														id: answer.stored.request.id,
													},
													revision: answer.stored.request.revision,
												},
											],
										},
										requests.decide(
											actor.organizationId,
											current.stored.request.id,
											{
												by: { _tag: "Bot", bot: current.bot.id },
												allow: input.allow,
												expected: current.stored.request.revision,
												holds,
												...(input.scope === undefined
													? {}
													: { scope: input.scope }),
												...(input.reason === undefined
													? {}
													: { reason: input.reason }),
												...(input.question === undefined
													? {}
													: { question: input.question }),
											},
										),
									)
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
						const current = yield* commands.load(key)
						if (current.stored.request.status === "pending")
							yield* store.requestDecision(
								{ ...key, generation: current.execution.generation },
								decisionId(current.stored.request),
								["allow", "deny"],
							)
						yield* audit.record({
							organizationId: actor.organizationId,
							actor,
							action: "capability.decided",
							resource: current.stored.request.id,
							details: {
								executionId: key.id,
								reviewExecutionId: review.id,
								bot: saved.host.bot,
								decision: input.allow ? "allow" : "deny",
							},
						})
						return { executionId: review.id, start: false }
					}),
			)
			return yield* outcome(receipt)
		})
		const replay = (error: Execution.Conflict | Execution.Forbidden) =>
			Effect.gen(function* () {
				yield* access.authorize(review, actor, "replay")
				yield* commands.authorize(key, actor, "replay")
				const prior = yield* store.receipt(
					review.namespace,
					commandKey,
					command,
				)
				if (Option.isNone(prior)) return yield* error
				return yield* outcome(prior.value)
			})
		return yield* apply.pipe(
			Effect.catchTags({
				ExecutionConflict: replay,
				ExecutionForbidden: replay,
			}),
		)
	}, storage)
	/** A proposal needs a person to activate it. Its receipt keeps the first Rule ID. */
	const proposalResult = (review: Key, receipt: Execution.Receipt) =>
		Effect.gen(function* () {
			const event = Arr.findFirst(
				yield* store.events(review, receipt.sequence - 1),
				(event) => event.sequence === receipt.sequence,
			)
			if (
				Option.isNone(event) ||
				event.value.body._tag !== "Checkpoint" ||
				event.value.body.resource.kind !== "Rule"
			)
				return yield* Execution.StorageError.make({
					cause: "The rule proposal has no saved Rule ID.",
				})
			return {
				receipt,
				ruleId: BotDomain.RuleId.make(event.value.body.resource.id),
			}
		})
	const propose = Effect.fn("BotDecisions.propose")(function* (
		key: Key,
		review: Fence,
		commandKey: Execution.CommandKey,
		input: typeof Proposal.Type,
	) {
		const saved = yield* load(key, review)
		const actor = saved.child.identity.actor
		yield* access.authorize(review, actor, "replay")
		yield* commands.authorize(key, actor, "replay")
		const command = {
			actor,
			body: {
				kind: "rule-proposal",
				requestExecutionId: key.id,
				reviewExecutionId: review.id,
				proposal: yield* Schema.encodeEffect(Proposal)(input),
			},
		}
		const receipt = yield* store.accept(
			review.namespace,
			commandKey,
			command,
			() =>
				Effect.gen(function* () {
					// Keep the same request, Chat, Turn lock order as a decision or review release.
					const request = yield* commands.load(key)
					yield* store.lock({
						...key,
						generation: request.execution.generation,
					})
					yield* StoredChats.lock(db, review.namespace, saved.chat.id)
					yield* store.lock(review)
					const current = yield* bound(key, review)
					if (
						current.child.record.status !== "running" ||
						current.execution.record.status === "cancelling" ||
						Execution.isTerminal(current.execution.record.status)
					)
						return yield* Execution.Conflict.make({ id: key.id })
					yield* access.authorize(review, actor, "advance")
					yield* commands.authorize(key, actor, "advance")
					const rule = yield* rules.create(actor.organizationId, {
						bot: current.stored.request.bot,
						author: { _tag: "Bot", bot: current.bot.id },
						text: input.text,
						status: "proposed",
					})
					yield* audit.record({
						organizationId: actor.organizationId,
						actor,
						action: "rule.created",
						resource: rule.bot,
						details: {
							rule: rule.id,
							reviewExecutionId: review.id,
							requestExecutionId: key.id,
						},
					})
					return {
						executionId: review.id,
						start: false,
						events: [
							{
								_tag: "Checkpoint" as const,
								resource: { kind: "Rule", id: rule.id },
								revision: rule.version,
							},
						],
					}
				}),
		)
		return yield* proposalResult(review, receipt)
	}, storage)
	/** These reads never create a command. They can finish a sent tool after its decision closes the review. */
	const readDecision = Effect.fn("BotDecisions.readDecision")(function* (
		key: Key,
		review: Fence,
		commandKey: Execution.CommandKey,
		input: typeof Decision.Type,
	) {
		const saved = yield* load(key, review)
		const actor = saved.child.identity.actor
		yield* access.authorize(review, actor, "replay")
		yield* commands.authorize(key, actor, "replay")
		const receipt = yield* store.receipt(review.namespace, commandKey, {
			actor,
			body: {
				requestExecutionId: key.id,
				reviewExecutionId: review.id,
				decision: yield* Schema.encodeEffect(Decision)(input),
			},
		})
		if (Option.isNone(receipt)) return Option.none()
		// A concurrent command may have committed after load and before the receipt read.
		const current = yield* commands.load(key)
		return Option.some({
			receipt: receipt.value,
			outcome:
				input.allow &&
				Arr.some(
					current.stored.request.endorsements,
					(entry) => entry.bot === saved.host.bot,
				)
					? ("passed" as const)
					: input.allow
						? ("allowed" as const)
						: ("denied" as const),
		})
	}, storage)
	const readProposal = Effect.fn("BotDecisions.readProposal")(function* (
		key: Key,
		review: Fence,
		commandKey: Execution.CommandKey,
		input: typeof Proposal.Type,
	) {
		const saved = yield* load(key, review)
		const actor = saved.child.identity.actor
		yield* access.authorize(review, actor, "replay")
		yield* commands.authorize(key, actor, "replay")
		const receipt = yield* store.receipt(review.namespace, commandKey, {
			actor,
			body: {
				kind: "rule-proposal",
				requestExecutionId: key.id,
				reviewExecutionId: review.id,
				proposal: yield* Schema.encodeEffect(Proposal)(input),
			},
		})
		return Option.isNone(receipt)
			? Option.none()
			: Option.some(yield* proposalResult(review, receipt.value))
	}, storage)
	return BotDecisions.of({
		forReview,
		decide,
		propose,
		readDecision,
		readProposal,
	})
})

export const layer = Layer.effect(BotDecisions, make)
