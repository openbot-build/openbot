import { Authorization, Caller, Execution } from "@openbot-build/domain"
import { Effect, Option, Schema } from "effect"
import * as Check from "../authorization/Check.ts"
import { Store, storage } from "../execution/Store.ts"
import type { Authorize } from "../execution/Engine.ts"
import { Channels } from "./Channels.ts"

const sameCaller = Schema.toEquivalence(Caller)
const Reference = Schema.Struct({ channelId: Schema.String })
/** Channel work keeps the caller saved at admission, including a revoked token. */
export const make = Effect.gen(function* () {
	const store = yield* Store
	const channels = yield* Channels
	const checks = yield* Check.make
	const authorize: Authorize = (key, actor, mode) =>
		Effect.gen(function* () {
			const saved = yield* store.loadMember(key)
			const input = yield* Schema.decodeUnknownEffect(Reference)(saved.input)
			if (actor.organizationId !== saved.identity.owner.organizationId)
				return yield* Execution.Forbidden.make({})
			const resource = Authorization.Channel.make({
				organizationId: actor.organizationId,
				id: input.channelId,
			})
			if (mode === "advance" || mode === "replay") {
				if (!sameCaller(actor, saved.identity.actor))
					return yield* Execution.Forbidden.make({})
				const current = yield* channels.get(
					actor.organizationId,
					input.channelId,
				)
				if (
					Option.isNone(current) ||
					!current.value.enabled ||
					current.value.needsAuthorization ||
					current.value.actor !== saved.identity.owner.userId
				)
					return yield* Execution.Forbidden.make({})
				yield* Check.execution(checks, saved.identity, {
					action: "use",
					resource,
				})
			} else
				yield* checks.check(actor, {
					action: mode === "read" ? "read" : "write",
					resource,
				})
		}).pipe(
			Effect.catchTags({
				Forbidden: () => Effect.fail(Execution.Forbidden.make({})),
				Pending: () => Effect.fail(Execution.Forbidden.make({})),
			}),
			storage,
		)
	return authorize
})
