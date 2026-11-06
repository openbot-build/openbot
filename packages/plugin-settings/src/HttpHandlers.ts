import { SettingsUnavailable } from "@openbot-build/domain/SettingsErrors"
import { SettingsInvalid } from "@openbot-build/domain/Settings"
import { Identity } from "@openbot-build/domain/Identity"
import { OpenBotApi } from "@openbot-build/api"

import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import * as Failures from "@openbot-build/server-kernel/Failures"
import * as DefaultBot from "@openbot-build/conversation-contract/bots/DefaultBot"
import { Settings } from "@openbot-build/server-kernel/Settings"
import * as Views from "@openbot-build/server-kernel/Views"

/** The settings of the caller. Each member reads and changes only their own. */
export const layerMember = HttpApiBuilder.group(
	OpenBotApi,
	"memberSettings",
	(handlers) =>
		Effect.gen(function* () {
			const settings = yield* Settings
			const defaultBot = yield* DefaultBot.make
			/** A failure of the check that is not about the chosen Bot. The log keeps the reason. */
			const unavailable = <const K extends string>(tag: K) =>
				Failures.replaceTag(
					tag,
					"OpenBot could not check the default Bot.",
					() => SettingsUnavailable.make({}),
				)
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
						const chosen = changes.defaultBot
						if (chosen !== undefined && chosen !== null)
							yield* defaultBot.check(caller, chosen).pipe(
								unavailable("BotConflict"),
								unavailable("BotStorageUnavailable"),
								unavailable("PolicyUnavailable"),
								Effect.catchTags({
									BotNotFound: (error) =>
										Effect.fail(
											SettingsInvalid.make({
												message: `There is no Bot ${error.bot}.`,
											}),
										),
									Forbidden: () =>
										Effect.fail(
											SettingsInvalid.make({
												message: `You cannot give work to Bot ${chosen}.`,
											}),
										),
									Pending: () =>
										Effect.fail(
											SettingsInvalid.make({
												message: `You cannot give work to Bot ${chosen}.`,
											}),
										),
									BotInvalid: (error) =>
										Effect.fail(
											SettingsInvalid.make({ message: error.message }),
										),
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
