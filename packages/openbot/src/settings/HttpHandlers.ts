import { Identity, OpenBotApi } from "@openbot-build/api"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Settings } from "./Settings.ts"
import * as Views from "./Views.ts"

/** The settings of the caller. Each member reads and changes only their own. */
export const layerMember = HttpApiBuilder.group(
	OpenBotApi,
	"memberSettings",
	(handlers) =>
		Effect.gen(function* () {
			const settings = yield* Settings
			return handlers
				.handle("getMemberSettings", () =>
					Effect.flatMap(Identity, (caller) =>
						settings.member(caller.organizationId, caller.userId),
					).pipe(Effect.map(Views.member)),
				)
				.handle("updateMemberSettings", ({ payload }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const { expectedVersion, ...changes } = payload
						const updated = yield* settings.updateMember(
							caller.organizationId,
							caller.userId,
							expectedVersion,
							(current) => Effect.succeed({ ...current, ...changes }),
						)
						return Views.member(updated)
					}),
				)
		}),
)
