import { Execution, ExecutionIdentity } from "@openbot-build/domain"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { Registry } from "./Engine.ts"
import { Store } from "./Store.ts"

/** A remote adapter reads the saved identity from this call before sending. */
export const Reference = Schema.Struct({
	namespace: Schema.String,
	id: Execution.Id,
	generation: Execution.Generation,
	callId: Execution.CallId,
})
export type Reference = typeof Reference.Type

export const Authority = Schema.TaggedUnion({
	Call: { reference: Reference },
	Request: { identity: ExecutionIdentity },
})
export type Authority = typeof Authority.Type
/** The explicit call or request context at an outside send boundary. */
export const Current = Context.Reference<Option.Option<Authority>>(
	"@openbot-build/openbot/execution/Send/Current",
	{ defaultValue: Option.none },
)
export const authority = (
	identity: ExecutionIdentity,
): Effect.Effect<Authority> =>
	Effect.map(
		Current,
		Option.getOrElse(() => Authority.cases.Request.make({ identity })),
	)

export const provide = (authority: Authority) =>
	Effect.provideService(Current, Option.some(authority))

const make = Effect.gen(function* () {
	const store = yield* Store
	const registry = yield* Registry
	const resolve = Effect.fn("SendAccess.resolve")(function* (
		authority: Authority,
	) {
		if (authority._tag === "Request") return authority.identity
		const ref = authority.reference
		const saved = yield* store.loadMember(ref)
		if (
			saved.generation !== ref.generation ||
			saved.record.status !== "running" ||
			saved.phaseFailed
		)
			return yield* Execution.Conflict.make({ id: ref.id })
		const call = yield* store.call(ref, ref.callId)
		if (Option.isNone(call) || call.value.status !== "sending")
			return yield* Execution.Conflict.make({ id: ref.id })
		const feature = yield* registry.get(saved.workflow)
		if (Option.isNone(feature)) return yield* Execution.Forbidden.make({})
		yield* feature.value.authorize(ref, saved.identity.actor, "advance")
		if (feature.value.admit !== undefined)
			yield* feature.value.admit(ref, false, call.value)
		return saved.identity
	})
	return { resolve }
})
export class Access extends Context.Service<
	Access,
	Effect.Success<typeof make>
>()("@openbot-build/openbot/execution/Send/Access") {}
export const layer = Layer.effect(Access, make)
