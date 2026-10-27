import {
	Array as Arr,
	Cause,
	Clock,
	Crypto,
	Effect,
	Option,
	Schema,
} from "effect"
import { DurableClock } from "effect/workflow"
import { Base64Url } from "effect/encoding"
import { Execution } from "@openbot-build/domain"
import { Records } from "../errors/Records.ts"
import { Calls } from "../execution/Calls.ts"
import { Store, type Fence } from "../execution/Store.ts"
import {
	Channel,
	ChannelDeliveryFailed,
	ChannelEventSchema,
	MessageRef,
	OutboundMessage,
	TargetSchema,
	Target,
} from "./Channel.ts"
import { chunk } from "./Text.ts"

const inputCodec = Schema.toCodecJson(
	Schema.Struct({
		target: TargetSchema,
		message: OutboundMessage,
		ref: Schema.NullOr(MessageRef),
	}),
)
const refCodec = Schema.toCodecJson(MessageRef)
const Outcome = Schema.TaggedUnion({
	Completed: { value: Schema.Json },
	Rejected: {
		failure: Execution.Failure,
		retryAt: Schema.NullOr(Schema.Finite),
	},
})
export const make = Effect.gen(function* () {
	const store = yield* Store
	const calls = yield* Calls
	const errors = yield* Records
	const crypto = yield* Crypto.Crypto
	/** A known rejection is a saved result. An unclear write still needs a decision. */
	const invoke = (
		fence: Fence,
		step: string,
		input: Schema.Json,
		send: (
			key: string,
		) => Effect.Effect<Schema.Json, ChannelDeliveryFailed | Schema.SchemaError>,
	) =>
		Effect.gen(function* () {
			// Lark keeps duplicate keys for one hour only. Unknown writes still need
			// a decision after a restart; a key is not proof of an unlimited retry window.
			const key = Base64Url.encode(
				yield* crypto
					.digest(
						"SHA-256",
						new TextEncoder().encode(
							yield* Schema.encodeEffect(
								Schema.fromJsonString(Schema.Array(Schema.String)),
							)([fence.namespace, fence.id, step]),
						),
					)
					.pipe(Effect.orDie),
			)
			while (true) {
				const call = yield* store.writeAttempt(fence, step, input, "never")
				const result = yield* calls.invoke(
					fence,
					{ step: call.step, attempt: call.attempt, retry: call.retry, input },
					() =>
						send(key).pipe(
							Effect.map((value): typeof Outcome.Type => ({
								_tag: "Completed",
								value,
							})),
							Effect.catchTag("ChannelDeliveryFailed", (error) =>
								Effect.gen(function* () {
									if (error.outcome !== "rejected") return yield* error
									const failure = yield* errors.record(
										Cause.fail(error),
										error.retry ? "external" : "invalid",
										fence.id,
									)
									return {
										_tag: "Rejected",
										failure,
										retryAt: error.retry
											? (yield* Clock.currentTimeMillis) +
												Math.max(
													1000,
													error.retryAfterMs ?? 1000 * 2 ** call.attempt,
												)
											: null,
									} satisfies typeof Outcome.Type
								}),
							),
							Effect.flatMap(Schema.encodeEffect(Schema.toCodecJson(Outcome))),
						),
				)
				if (result._tag === "Unknown") return Option.none<Schema.Json>()
				const saved = yield* Schema.decodeUnknownEffect(Outcome)(result.result)
				if (saved._tag === "Completed") return Option.some(saved.value)
				if (saved.retryAt === null || call.attempt >= 4)
					return yield* Effect.fail(saved.failure)
				const remaining = saved.retryAt - (yield* Clock.currentTimeMillis)
				if (remaining > 0)
					yield* DurableClock.sleep({
						name: "channel-retry:" + call.id,
						duration: remaining,
						inMemoryThreshold: 0,
					})
				// The next attempt checks the current owner and caller again before sending.
				yield* store.repeatCall(fence, call.id, result.result)
			}
		})
	const send = (
		fence: Fence,
		channel: Channel,
		step: string,
		target: Target,
		message: OutboundMessage,
		ref: MessageRef | null = null,
	) =>
		Effect.gen(function* () {
			const parts = chunk(message.markdown, channel.features.maxLength)
			let first = Option.none<MessageRef>()
			for (const [index, markdown] of Arr.map(
				parts,
				(text, index) => [index, text] as const,
			)) {
				const part = {
					markdown,
					...(index === parts.length - 1 && message.buttons !== undefined
						? { buttons: message.buttons }
						: {}),
				}
				const place =
					index === 0 || Option.isNone(first)
						? target
						: Target.Conversation({ conversation: first.value.conversation })
				const edit = index === 0 && channel.features.edit ? ref : null
				const input = yield* Schema.encodeEffect(inputCodec)({
					target: place,
					message: part,
					ref: edit,
				})
				const result = yield* invoke(fence, step + ":" + index, input, (key) =>
					(edit === null
						? channel.send(place, part, key)
						: channel.edit(edit, part, key).pipe(Effect.as(edit))
					).pipe(Effect.flatMap(Schema.encodeEffect(refCodec))),
				)
				if (Option.isNone(result)) return Option.none<MessageRef>()
				const saved = yield* Schema.decodeUnknownEffect(MessageRef)(
					result.value,
				)

				if (index === 0) first = Option.some(saved)
			}
			return first
		})
	const acknowledge = (
		fence: Fence,
		channel: Channel,
		event: Extract<typeof ChannelEventSchema.Type, { readonly _tag: "Action" }>,
	) =>
		Effect.gen(function* () {
			const input = yield* Schema.encodeEffect(
				Schema.toCodecJson(ChannelEventSchema),
			)(event)
			return Option.isSome(
				yield* invoke(fence, "acknowledge", input, () =>
					channel.acknowledge(event).pipe(Effect.as(null)),
				),
			)
		})
	const register = (
		fence: Fence,
		channel: Channel,
		input: {
			readonly channelId: string
			readonly version: number
			readonly webhookUrl: string
		},
	) =>
		invoke(fence, "register", input, () =>
			channel.register(input.webhookUrl).pipe(Effect.as(null)),
		).pipe(Effect.map(Option.isSome))

	return { send, acknowledge, register }
})
