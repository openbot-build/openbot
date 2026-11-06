import { Effect, Layer, Option } from "effect"
import * as CapabilityAccess from "@openbot-build/plugin-capabilities/CapabilityAccess"
import { Grants } from "@openbot-build/conversation-contract/capabilities/Grants"

/**
 * The checks of a Bot for tests that run no saved execution. A matching
 * Grant is used at once, so a one-use Grant works one time.
 */
export const layer = Layer.effect(
	CapabilityAccess.CapabilityAccess,
	Effect.gen(function* () {
		const grants = yield* Grants
		return yield* CapabilityAccess.makeWith((current, attempt) =>
			Effect.gen(function* () {
				const grant = yield* grants.match({
					organizationId: current.identity.owner.organizationId,
					bot: current.bot.id,
					capability: attempt.capability,
					chat: current.chat,
				})
				if (Option.isNone(grant) || grant.value.effect === "deny") return grant
				return (yield* grants.use(
					current.identity.owner.organizationId,
					grant.value,
				))
					? grant
					: Option.none()
			}),
		)
	}),
)
