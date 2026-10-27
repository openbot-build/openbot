import { Identity, OpenBotApi, Settings as Api } from "@openbot-build/api"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import * as Failures from "../app/Failures.ts"
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
			const defaultBot = yield* DefaultBot.make
			/** A failure of the check that is not about the chosen Bot. The log keeps the reason. */
			const unavailable = <const K extends string>(tag: K) =>
				Failures.replaceTag(
					tag,
					"OpenBot could not check the default Bot.",
					() => Api.SettingsUnavailable.make({}),
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
											Api.SettingsInvalid.make({
												message: `There is no Bot ${error.bot}.`,
											}),
										),
									Forbidden: () =>
										Effect.fail(
											Api.SettingsInvalid.make({
												message: `You cannot give work to Bot ${chosen}.`,
											}),
										),
									Pending: () =>
										Effect.fail(
											Api.SettingsInvalid.make({
												message: `You cannot give work to Bot ${chosen}.`,
											}),
										),
									BotInvalid: (error) =>
										Effect.fail(
											Api.SettingsInvalid.make({ message: error.message }),
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
