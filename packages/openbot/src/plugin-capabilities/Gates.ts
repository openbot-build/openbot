import { Execution, ExecutionIdentity } from "@openbot-build/domain"
import {
	Cause,
	Context,
	Effect,
	HashMap,
	Layer,
	Option,
	Ref,
	Schema,
} from "effect"
import { Digest } from "effect/crypto"
import * as Hex from "effect/encoding/Hex"
import {
	Answer,
	Gate,
	Gates,
	type Frame,
} from "@openbot-build/conversation-contract/capabilities/Gate"
import * as PolicyOrigin from "@openbot-build/conversation-contract/capabilities/PolicyOrigin"
import {
	RequestCommands,
	type Input,
} from "@openbot-build/conversation-contract/capabilities/RequestCommands"
import type { Stored } from "@openbot-build/conversation-contract/capabilities/Requests"
import { TurnContext } from "@openbot-build/conversation-contract/chats/TurnContext"
import { type Fence } from "@openbot-build/server-execution/execution/Store"
import * as Recovery from "@openbot-build/server-execution/execution/Recovery"
import { toolJson } from "@openbot-build/tools-contract/plugins/ToolJson"
import * as CapabilityPolicy from "./CapabilityAccess.ts"
import * as Judge from "./Judge.ts"

/** A saved request keeps the call. Its workflow delivers any later result. */
const requestAnswer = (stored: Stored, executionId: Execution.Id): Answer =>
	stored.request.status === "denied"
		? Answer.Deny({
				request: stored.request.id,
				reason: stored.request.decision?.reason ?? "The request was denied.",
			})
		: Answer.Pending({ request: stored.request.id, executionId })

const durable = (
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
		const crypto = yield* Digest.Digest
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
						Digest.sha256,
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

/** The services that the Gate of one execution needs. */
type Needs = Effect.Services<ReturnType<typeof durable>>

/**
 * Gives `Gates`. It keeps the services of the Gates when it is built. A service
 * that the caller has, such as a fake in a test, wins over the kept one, as it
 * did when callers made each Gate with their own services.
 */
export const layer = Layer.effect(
	Gates,
	Effect.gen(function* () {
		const kept = yield* Effect.context<Needs>()
		return Gates.of({
			durable: (fence, work, continuation, control) =>
				Effect.flatMap(Effect.context<never>(), (current) =>
					durable(fence, work, continuation, control).pipe(
						Effect.provideContext(Context.merge(kept, current)),
					),
				),
		})
	}),
)
