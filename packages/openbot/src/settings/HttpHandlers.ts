import type { Services as AuthorizationServices } from "../authorization/Authorize.ts"
import { Identity, OpenBotApi, Settings as Api } from "@openbot-build/api"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import * as DefaultAgent from "../agents/DefaultAgent.ts"
import { Settings } from "./Settings.ts"
import * as Views from "./Views.ts"

/** The settings of the caller. Each member reads and changes only their own. */
export const layerMember = HttpApiBuilder.group(
	OpenBotApi,
	"memberSettings",
	(handlers) =>
		Effect.gen(function* () {
			const settings = yield* Settings
			const services = yield* Effect.context<
				AuthorizationServices | DefaultAgent.Services
			>()
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
						const defaultAgent = changes.defaultAgent
						if (defaultAgent !== undefined && defaultAgent !== null)
							yield* DefaultAgent.check(caller, defaultAgent).pipe(
								Effect.provideContext(services),
								Effect.catchTags({
									AgentNotFound: (error) =>
										Effect.fail(
											Api.SettingsInvalid.make({
												message: `There is no Agent ${error.agent}.`,
											}),
										),
									PermissionDenied: () =>
										Effect.fail(
											Api.SettingsInvalid.make({
												message: `You cannot give work to Agent ${defaultAgent}.`,
											}),
										),
									AgentInvalid: (error) =>
										Effect.fail(
											Api.SettingsInvalid.make({ message: error.message }),
										),
									AgentConflict: () =>
										Effect.fail(Api.SettingsUnavailable.make({})),
									AgentStorageUnavailable: () =>
										Effect.fail(Api.SettingsUnavailable.make({})),
									AuthorizationUnavailable: () =>
										Effect.fail(Api.SettingsUnavailable.make({})),
								}),
							)
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
