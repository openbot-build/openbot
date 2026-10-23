import type { Services as AuthorizationServices } from "../authorization/Authorize.ts"
import { Identity, OpenBotApi, Settings as Api } from "@openbot-build/api"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import * as DefaultBot from "../bots/DefaultBot.ts"
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
				AuthorizationServices | DefaultBot.Services
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
						const defaultBot = changes.defaultBot
						if (defaultBot !== undefined && defaultBot !== null)
							yield* DefaultBot.check(caller, defaultBot).pipe(
								Effect.provideContext(services),
								Effect.catchTags({
									BotNotFound: (error) =>
										Effect.fail(
											Api.SettingsInvalid.make({
												message: `There is no Bot ${error.bot}.`,
											}),
										),
									PermissionDenied: () =>
										Effect.fail(
											Api.SettingsInvalid.make({
												message: `You cannot give work to Bot ${defaultBot}.`,
											}),
										),
									BotInvalid: (error) =>
										Effect.fail(
											Api.SettingsInvalid.make({ message: error.message }),
										),
									BotConflict: () =>
										Effect.fail(Api.SettingsUnavailable.make({})),
									BotStorageUnavailable: () =>
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
