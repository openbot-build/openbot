import { Operation } from "@openbot-build/core"
import { Execution } from "@openbot-build/domain"
import {
	Array as Arr,
	Cause,
	Context,
	Effect,
	Layer,
	Schema,
	Record as Rec,
	Option,
} from "effect"
import { Tool, Toolkit } from "effect/ai"
import { Records, category } from "../errors/Records.ts"
import { CallContext } from "../execution/CallContext.ts"
import * as Recovery from "../execution/Recovery.ts"
import type { Fence } from "../execution/Store.ts"
import { Local, ReviewAllowed, SavedResult } from "../plugins/ToolEntry.ts"
import * as BotDecisions from "./BotDecisions.ts"
import * as CapabilityAccess from "./CapabilityAccess.ts"
import * as Judge from "./Judge.ts"

export const names = {
	approve: "openbot_approve",
	deny: "openbot_deny",
	ask: "openbot_ask",
	escalate: "openbot_escalate",
	proposeRule: "openbot_propose_rule",
} as const
const Scope = Schema.Literals(["once", "chat", "lifetime"])
const Approve = Schema.Struct({
	scope: Scope,
	reason: BotDecisions.Decision.fields.reason,
})
const Deny = Schema.Struct({
	reason: Schema.String.check(Schema.isMaxLength(2000)),
	scope: Schema.optionalKey(Scope),
})
const Ask = Schema.Struct({
	question: Schema.String.check(Schema.isMaxLength(4000)),
})
const Escalate = Schema.Struct({
	note: Schema.String.check(Schema.isMaxLength(2000)),
})

/** The review's model cannot supply an execution, actor, request or command key. */
export const register = (fence: Fence) =>
	Effect.gen(function* () {
		const decisions = yield* BotDecisions.BotDecisions
		const recovery = yield* Recovery.make
		const errors = yield* Records
		const key = yield* recovery.storage(fence.id, decisions.forReview(fence))
		const command = Effect.gen(function* () {
			const current = yield* CallContext
			if (
				current.fence.namespace !== fence.namespace ||
				current.fence.id !== fence.id ||
				current.fence.generation !== fence.generation
			)
				return yield* Execution.Conflict.make({ id: fence.id })
			return Execution.CommandKey.make(`review-tool:${current.id}`)
		})
		const decide = (input: typeof BotDecisions.Decision.Type) =>
			Effect.gen(function* () {
				const result = yield* decisions.decide(
					key,
					fence,
					yield* command,
					input,
				)
				return result.outcome === "passed"
					? { passedUp: true }
					: { decided: result.outcome }
			})
		const recovered = (
			name: (typeof names)[keyof typeof names],
			id: Execution.CallId,
			raw: unknown,
		) =>
			Effect.gen(function* () {
				const commandKey = Execution.CommandKey.make(`review-tool:${id}`)
				if (name === names.proposeRule)
					return Option.map(
						yield* decisions.readProposal(
							key,
							fence,
							commandKey,
							yield* Schema.decodeUnknownEffect(BotDecisions.Proposal)(raw),
						),
						(result) => ({ proposed: result.ruleId }),
					)
				const input =
					name === names.approve
						? {
								...(yield* Schema.decodeUnknownEffect(Approve)(raw)),
								allow: true,
							}
						: name === names.deny
							? {
									...(yield* Schema.decodeUnknownEffect(Deny)(raw)),
									allow: false,
								}
							: name === names.ask
								? {
										...(yield* Schema.decodeUnknownEffect(Ask)(raw)),
										allow: false,
										reason: "The decider has a question.",
									}
								: {
										allow: true,
										scope: "once" as const,
										reason: (yield* Schema.decodeUnknownEffect(Escalate)(raw))
											.note,
										endorseOnly: true,
									}
				return Option.map(
					yield* decisions.readDecision(key, fence, commandKey, input),
					(result) =>
						result.outcome === "passed"
							? { passedUp: true }
							: { decided: result.outcome },
				)
			}).pipe(
				(work) => recovery.storage(fence.id, work),
				Effect.catchCause((cause) =>
					Cause.hasInterruptsOnly(cause)
						? Effect.interrupt
						: errors
								.record(cause, category(cause), fence.id)
								.pipe(Effect.orDie, Effect.flatMap(Effect.fail)),
				),
			)
		const own = Toolkit.make(
			Tool.make(names.approve, {
				description:
					"Allow this request. If you cannot allow it, send it up with your support.",
				parameters: Approve,
				success: Schema.Json,
			}),
			Tool.make(names.deny, {
				description: "Deny this request and say why.",
				parameters: Deny,
				success: Schema.Json,
			}),
			Tool.make(names.ask, {
				description:
					"Ask the requesting Bot a question. Deny this request for now.",
				parameters: Ask,
				success: Schema.Json,
			}),
			Tool.make(names.escalate, {
				description: "Send this request to your own decider.",
				parameters: Escalate,
				success: Schema.Json,
			}),
			Tool.make(names.proposeRule, {
				description:
					"Propose a Rule for future requests. A person must confirm it.",
				parameters: BotDecisions.Proposal,
				success: Schema.Json,
			}),
		)
		// Each handler reads the saved call at send time, including after takeover.
		const tools = Toolkit.make(
			...Arr.map(Rec.values(own.tools), (tool) =>
				tool
					.addDependency(CallContext)
					.annotate(Local, true)
					.annotate(SavedResult, (id, raw) => recovered(tool.name, id, raw))
					.annotate(ReviewAllowed, true)
					.annotate(Operation.Budget, "foreground"),
			),
		)
		const safe =
			<A, E>(
				handle: (input: A) => Effect.Effect<Schema.Json, E, CallContext>,
			) =>
			(input: A) =>
				recovery.storage(fence.id, handle(input)).pipe(
					Effect.catchCause((cause) =>
						Cause.hasInterruptsOnly(cause)
							? Effect.interrupt
							: errors.record(cause, category(cause), fence.id).pipe(
									Effect.map((failure) => ({ failure })),
									Effect.orDie,
								),
					),
				)
		const handlers = yield* tools.toHandlers({
			[names.approve]: safe((input: typeof Approve.Type) =>
				decide({ ...input, allow: true }),
			),
			[names.deny]: safe((input: typeof Deny.Type) =>
				decide({ ...input, allow: false }),
			),
			[names.ask]: safe((input: typeof Ask.Type) =>
				decide({
					...input,
					allow: false,
					reason: "The decider has a question.",
				}),
			),
			[names.escalate]: safe((input: typeof Escalate.Type) =>
				decide({
					allow: true,
					scope: "once",
					reason: input.note,
					endorseOnly: true,
				}),
			),
			[names.proposeRule]: safe((input: typeof BotDecisions.Proposal.Type) =>
				Effect.gen(function* () {
					const result = yield* decisions.propose(
						key,
						fence,
						yield* command,
						input,
					)
					return { proposed: result.ruleId }
				}),
			),
		})
		return { tools: tools.tools, handlers }
	})

const scoped = (fence: Fence) =>
	Effect.gen(function* () {
		const judge = yield* Judge.durable(fence)
		const access = yield* CapabilityAccess.durable(fence).pipe(
			Effect.provideService(Judge.Judge, judge),
		)
		const decisions = yield* BotDecisions.make.pipe(
			Effect.provideService(CapabilityAccess.CapabilityAccess, access),
		)
		return yield* register(fence).pipe(
			Effect.provideService(BotDecisions.BotDecisions, decisions),
		)
	})
export interface Service {
	readonly register: (fence: Fence) => Effect.Effect<
		{
			tools: {
				readonly openbot_approve: Tool.Tool<
					"openbot_approve",
					{
						readonly parameters: Schema.Struct<{
							readonly scope: Schema.Literals<
								readonly ["once", "chat", "lifetime"]
							>
							readonly reason: Schema.optionalKey<Schema.String>
						}>
						readonly success: Schema.Codec<
							Schema.Json,
							Schema.Json,
							never,
							never
						>
						readonly failure: Schema.Never
						readonly failureMode: "error"
					},
					CallContext
				>
				readonly openbot_ask: Tool.Tool<
					"openbot_ask",
					{
						readonly parameters: Schema.Struct<{
							readonly question: Schema.String
						}>
						readonly success: Schema.Codec<
							Schema.Json,
							Schema.Json,
							never,
							never
						>
						readonly failure: Schema.Never
						readonly failureMode: "error"
					},
					CallContext
				>
				readonly openbot_deny: Tool.Tool<
					"openbot_deny",
					{
						readonly parameters: Schema.Struct<{
							readonly reason: Schema.String
							readonly scope: Schema.optionalKey<
								Schema.Literals<readonly ["once", "chat", "lifetime"]>
							>
						}>
						readonly success: Schema.Codec<
							Schema.Json,
							Schema.Json,
							never,
							never
						>
						readonly failure: Schema.Never
						readonly failureMode: "error"
					},
					CallContext
				>
				readonly openbot_escalate: Tool.Tool<
					"openbot_escalate",
					{
						readonly parameters: Schema.Struct<{ readonly note: Schema.String }>
						readonly success: Schema.Codec<
							Schema.Json,
							Schema.Json,
							never,
							never
						>
						readonly failure: Schema.Never
						readonly failureMode: "error"
					},
					CallContext
				>
				readonly openbot_propose_rule: Tool.Tool<
					"openbot_propose_rule",
					{
						readonly parameters: Schema.Struct<{ readonly text: Schema.String }>
						readonly success: Schema.Codec<
							Schema.Json,
							Schema.Json,
							never,
							never
						>
						readonly failure: Schema.Never
						readonly failureMode: "error"
					},
					CallContext
				>
			}
			handlers: Context.Context<
				Tool.HandlersFor<{
					readonly openbot_approve: Tool.Tool<
						"openbot_approve",
						{
							readonly parameters: Schema.Struct<{
								readonly scope: Schema.Literals<
									readonly ["once", "chat", "lifetime"]
								>
								readonly reason: Schema.optionalKey<Schema.String>
							}>
							readonly success: Schema.Codec<
								Schema.Json,
								Schema.Json,
								never,
								never
							>
							readonly failure: Schema.Never
							readonly failureMode: "error"
						},
						CallContext
					>
					readonly openbot_ask: Tool.Tool<
						"openbot_ask",
						{
							readonly parameters: Schema.Struct<{
								readonly question: Schema.String
							}>
							readonly success: Schema.Codec<
								Schema.Json,
								Schema.Json,
								never,
								never
							>
							readonly failure: Schema.Never
							readonly failureMode: "error"
						},
						CallContext
					>
					readonly openbot_deny: Tool.Tool<
						"openbot_deny",
						{
							readonly parameters: Schema.Struct<{
								readonly reason: Schema.String
								readonly scope: Schema.optionalKey<
									Schema.Literals<readonly ["once", "chat", "lifetime"]>
								>
							}>
							readonly success: Schema.Codec<
								Schema.Json,
								Schema.Json,
								never,
								never
							>
							readonly failure: Schema.Never
							readonly failureMode: "error"
						},
						CallContext
					>
					readonly openbot_escalate: Tool.Tool<
						"openbot_escalate",
						{
							readonly parameters: Schema.Struct<{
								readonly note: Schema.String
							}>
							readonly success: Schema.Codec<
								Schema.Json,
								Schema.Json,
								never,
								never
							>
							readonly failure: Schema.Never
							readonly failureMode: "error"
						},
						CallContext
					>
					readonly openbot_propose_rule: Tool.Tool<
						"openbot_propose_rule",
						{
							readonly parameters: Schema.Struct<{
								readonly text: Schema.String
							}>
							readonly success: Schema.Codec<
								Schema.Json,
								Schema.Json,
								never,
								never
							>
							readonly failure: Schema.Never
							readonly failureMode: "error"
						},
						CallContext
					>
				}>
			>
		},
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.NotFound
		| Execution.StorageError
	>
}

export class ReviewTools extends Context.Service<ReviewTools, Service>()(
	"@openbot-build/openbot/capabilities/ReviewTools",
) {}

const make = Effect.gen(function* () {
	const services =
		yield* Effect.context<Effect.Services<ReturnType<typeof scoped>>>()
	return ReviewTools.of({
		register: (fence: Fence) =>
			scoped(fence).pipe(Effect.provideContext(services)),
	})
})

export const layer = Layer.effect(ReviewTools, make)
