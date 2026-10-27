import * as ChannelAdmission from "./ChannelAdmission.ts"
import { Chat } from "@openbot-build/core"
import { Execution } from "@openbot-build/domain"
import { Effect, Context, Layer, Schema } from "effect"
import { Store, storage, type Fence, type Key } from "../execution/Store.ts"

export const workflowName = "openbot.channel-watch"
export const Input = Schema.Struct({
	channelId: Schema.String,
	conversation: Schema.String,
	sourceExecutionId: Execution.Id,
	reply: Schema.Boolean,
	chat: Chat.Id,
})
const codec = Schema.toCodecJson(Input)
const make = Effect.gen(function* () {
	const store = yield* Store
	const admit = yield* ChannelAdmission.make
	const start = (namespace: string, input: typeof Input.Type) =>
		Effect.gen(function* () {
			const source = yield* store.loadMember({
				namespace,
				id: input.sourceExecutionId,
			})
			const body = yield* Schema.encodeEffect(codec)(input)
			return yield* store.accept(
				namespace,
				Execution.CommandKey.make("channel-watch:" + input.sourceExecutionId),
				{ actor: source.identity.actor, body },
				(create) =>
					Effect.gen(function* () {
						yield* admit(source.identity.owner.organizationId, input.channelId)
						const key = yield* create({
							workflow: workflowName,
							context: { kind: "Chat", id: input.chat },
							identity: source.identity,
							resource: { kind: "ChannelWatch", id: input.sourceExecutionId },
							input: body,
						})
						return { executionId: key.id, start: true }
					}),
			)
		})
	const load = (key: Key) =>
		Effect.gen(function* () {
			const execution = yield* store.loadMember(key)
			const input = yield* Schema.decodeUnknownEffect(Input)(execution.input)
			if (
				execution.workflow !== workflowName ||
				execution.record.resource.kind !== "ChannelWatch" ||
				execution.record.resource.id !== input.sourceExecutionId
			)
				return yield* Execution.Forbidden.make({})
			return { execution, input }
		}).pipe(storage)
	const finish = (
		fence: Fence,
		outcome:
			| {
					readonly status: "completed" | "failed" | "interrupted"
					readonly failure?: Execution.Failure
			  }
			| { readonly status: "cancelled"; readonly epoch: number },
	) =>
		outcome.status === "cancelled"
			? store.finishCancellation(fence, outcome.epoch).pipe(Effect.asVoid)
			: store.commit(fence, outcome, Effect.void)
	return { start, load, finish }
})
export class ChannelWatch extends Context.Service<
	ChannelWatch,
	Effect.Success<typeof make>
>()("@openbot-build/openbot/channels/ChannelWatch") {}
export const layer = Layer.effect(ChannelWatch, make)
