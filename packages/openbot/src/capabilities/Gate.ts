import {
	Execution,
	ExecutionIdentity,
	type AppCalls,
} from "@openbot-build/domain"
import type {
	Bots as BotsApi,
	Computers as ComputersApi,
} from "@openbot-build/domain"
import { CodeRuns as CodeDomain } from "@openbot-build/domain"
import {
	Cause,
	Context,
	Crypto,
	Schema,
	Data,
	Effect,
	HashMap,
	Option,
	Ref,
} from "effect"
import { type Capability } from "./Capability.ts"
import * as CapabilityPolicy from "./CapabilityAccess.ts"
import * as Judge from "./Judge.ts"
import type { Ask } from "./Requests.ts"
import { Work } from "./Work.ts"
import * as Hex from "effect/encoding/Hex"
import * as PolicyOrigin from "./PolicyOrigin.ts"
import { TurnContext } from "../chats/TurnContext.ts"
import { type Fence } from "../execution/Store.ts"
import * as Recovery from "../execution/Recovery.ts"
import { toolJson } from "../plugins/ToolJson.ts"
import { RequestCommands, type Input } from "./RequestCommands.ts"
import type { Stored } from "./Requests.ts"

/**
 * What a tool call does after the check. `Allow` runs it now. `Deny` does not run it,
 * and the Bot gets the reason. `Pending` waits for a decider: the Bot goes on at once,
 * and the answer comes back to its Chat later.
 */
export type Answer = Data.TaggedEnum<{
	Allow: {}
	Deny: { readonly request?: string; readonly reason: string }
	Pending: { readonly request: string; readonly executionId?: Execution.Id }
}>
export const Answer = Data.taggedEnum<Answer>()

export interface Attempt {
	readonly capability: Capability
	/** Why the Bot wants it, in its own words. */
	readonly reason: string
	readonly site: Execution.CallSite
	/** The target Bot, for actions on a Bot. */
	readonly target?: BotsApi.Bot
	/** The owner of the target Computer or Computer provider, for actions on Computers. */
	readonly computerOwner?: ComputersApi.ComputerOwner
	/** The deployment owner allows this without asking, for example a read-only App tool. */
	readonly implicit?: boolean
	readonly app?: AppCalls.Invocation
	/** The Code Mode program that makes the call. Deciders see it with the request. */
	readonly code?: CodeDomain.RequestCode
	/** How the request waits, when the attempt needs one. */
	readonly ask?: Ask
}

/**
 * Checks each attempt of a Bot to use a capability. Bots have no limits that they know of.
 * The steps are: the policy of the member, Grants, Rules with the judge, and then a request
 * to the decider above the Bot. The Grants of a Bot are an ability policy, see `Policy.ts`.
 */
export class Gate extends Context.Service<
	Gate,
	{
		/**
		 * A failed check denies the call. If its answer cannot be kept, the current
		 * scope stops, so approval cannot fall back to another policy.
		 */
		readonly check: (attempt: Attempt) => Effect.Effect<Answer>
		/** Keep a tool's own denial for the approval callback of this call. */
		readonly remember: (callId: string, answer: Answer) => Effect.Effect<void>
		/** Read only the answer for the current saved call occurrence. */
		readonly answer: (callId: string) => Effect.Effect<Option.Option<Answer>>
	}
>()("@openbot-build/openbot/capabilities/Gate") {}

/** A saved request keeps the call. Its workflow delivers any later result. */
const requestAnswer = (stored: Stored, executionId: Execution.Id): Answer =>
	stored.request.status === "denied"
		? Answer.Deny({
				request: stored.request.id,
				reason: stored.request.decision?.reason ?? "The request was denied.",
			})
		: Answer.Pending({ request: stored.request.id, executionId })

/** Bound before tool approval checks, so a model cannot choose an execution or actor. */
export type Frame = Pick<typeof Work.Service, "identity" | "chat" | "turn">
export const durable = (
	fence: Fence,
	work: Frame,
	continuation?: "chat" | "workflow",
	control?: PolicyOrigin.Control,
) =>
	Effect.gen(function* () {
		const frame = yield* PolicyOrigin.make
		const judge = yield* Judge.durable(
			fence,
			control === undefined
				? undefined
				: {
						key: PolicyOrigin.controlId(fence, control),
						authorize: frame
							.read(
								fence,
								Execution.mainCall(PolicyOrigin.controlId(fence, control)),
								control,
							)
							.pipe(Effect.asVoid),
					},
		)
		const access = yield* CapabilityPolicy.durable(fence, control).pipe(
			Effect.provideService(Judge.Judge, judge),
		)
		const requests = yield* RequestCommands
		const turns = yield* TurnContext
		const crypto = yield* Crypto.Crypto
		const recovery = yield* Recovery.make
		const sameIdentity = Schema.toEquivalence(ExecutionIdentity)
		const answers = yield* Ref.make(HashMap.empty<string, Answer>())
		const callKey = (site: Execution.CallSite) =>
			frame
				.read(fence, site, control)
				.pipe(
					Effect.flatMap((origin) =>
						Schema.encodeEffect(
							Schema.fromJsonString(Schema.Array(Schema.String)),
						)(origin.operation),
					),
				)
		const failed = (cause: Cause.Cause<unknown>) =>
			Cause.hasInterruptsOnly(cause)
				? Effect.interrupt
				: recovery.record(cause, fence.id).pipe(
						Effect.map((failure) =>
							Answer.Deny({
								reason: `OpenBot could not check this call. Error: ${failure.errorId}.`,
							}),
						),
					)
		const keep = (
			site: Execution.CallSite,
			answer: Answer,
		): Effect.Effect<void> =>
			callKey(site).pipe(
				Effect.flatMap((key) => Ref.update(answers, HashMap.set(key, answer))),
				// A lost denial must stop approval, even if storage comes back at once.
				Effect.catchCause((cause) =>
					failed(cause).pipe(
						Effect.andThen(Effect.failCause(cause)),
						Effect.orDie,
					),
				),
			)
		const remember: typeof Gate.Service.remember = (callId, answer) =>
			keep(Execution.mainCall(callId), answer)
		const answer: typeof Gate.Service.answer = (callId) =>
			callKey(Execution.mainCall(callId)).pipe(
				Effect.flatMap((key) =>
					Ref.get(answers).pipe(Effect.map((all) => HashMap.get(all, key))),
				),
				Effect.catchCause((cause) => failed(cause).pipe(Effect.asSome)),
			)
		const check: typeof Gate.Service.check = (attempt) =>
			Effect.gen(function* () {
				const origin = yield* frame.read(fence, attempt.site, control)
				if (
					!sameIdentity(origin.identity, work.identity) ||
					origin.position.chat !== work.chat ||
					origin.position.turn !== work.turn
				)
					return yield* Execution.Forbidden.make({})
				const current = yield* turns.prepare({
					identity: origin.identity,
					namespace: fence.namespace,
					chat: origin.position.chat,
					turn: origin.position.turn,
					host: origin.host,
				})
				const hash = Hex.encode(
					yield* crypto.digest(
						"SHA-256",
						new TextEncoder().encode(
							yield* Schema.encodeEffect(
								Schema.fromJsonString(Schema.Array(Schema.String)),
							)(origin.operation),
						),
					),
				)
				const key = Execution.CommandKey.make(`request:${fence.id}:${hash}`)
				const route =
					control === undefined
						? (continuation ??
							(attempt.code === undefined ? "chat" : "workflow"))
						: "workflow"
				const call =
					route === "chat" && attempt.capability.action !== "plans.run"
						? origin.call
						: Option.none()
				if (route === "chat" && Option.isNone(origin.call))
					return yield* Execution.Conflict.make({ id: fence.id })
				const input: Input = {
					...(control === undefined ? {} : { control }),
					continuation: route,
					capability: attempt.capability,
					reason: attempt.reason,
					toolCallId: attempt.site.main,
					...(attempt.app === undefined ? {} : { app: attempt.app }),
					...(attempt.code === undefined ? {} : { code: attempt.code }),
					...(attempt.ask === undefined ? {} : { ask: attempt.ask }),
					...(Option.isNone(call)
						? {}
						: {
								call: {
									name: call.value.name,
									params: toolJson(call.value.params ?? {}),
									...(origin.action?.name === call.value.name &&
									origin.action.source !== undefined
										? { source: origin.action.source }
										: {}),
								},
							}),
				}
				const prior = yield* requests.submitted(fence, key, input)
				if (Option.isSome(prior) && prior.value._tag === "Requested") {
					const member = yield* access.member(current, attempt)
					if (member._tag === "Deny")
						return Answer.Deny({ reason: member.reason })
					return requestAnswer(prior.value.stored, prior.value.executionId)
				}
				const decision = yield* access.check(current, attempt)
				const immediate =
					decision._tag === "Allow"
						? Answer.Allow()
						: Answer.Deny({
								reason:
									decision._tag === "Deny"
										? decision.reason
										: "This call no longer has permission to run.",
							})
				if (Option.isSome(prior)) return immediate
				const receipt =
					decision._tag === "Allow"
						? yield* requests.admit(fence, key, input)
						: yield* requests.submit(
								fence,
								key,
								input,
								decision._tag === "Deny"
									? { allow: false, by: decision.by, reason: decision.reason }
									: undefined,
							)
				if (receipt.executionId === fence.id) return immediate
				return requestAnswer(
					(yield* requests.load({
						namespace: fence.namespace,
						id: receipt.executionId,
					})).stored,
					receipt.executionId,
				)
			}).pipe(
				Effect.catchCause(failed),
				Effect.tap((answer) => keep(attempt.site, answer)),
			)
		return Gate.of({ check, remember, answer })
	})
