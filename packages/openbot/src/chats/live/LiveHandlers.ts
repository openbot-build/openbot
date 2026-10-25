import type { Services as AuthorizationServices } from "../../authorization/Check.ts"
import {
	Authorization,
	BotsApi,
	ChatStorageUnavailable,
	Identity,
	LiveApi,
	OpenBotApi,
} from "@openbot-build/api"
import { Config } from "@openbot-build/core"
import { Effect, Option, Result } from "effect"
import { HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { Backend } from "../../app/Backend.ts"
import { check } from "../../authorization/Check.ts"
import { Bots } from "../../bots/Bots.ts"
import { ModelRegistry } from "../../models/ModelRegistry.ts"
import * as ChatHost from "../ChatHost.ts"
import { chainFor } from "../ChatHandlers.ts"
import * as LiveSession from "./LiveSession.ts"
import { LiveSessions } from "./LiveSessions.ts"

export const layer = HttpApiBuilder.group(OpenBotApi, "live", (handlers) =>
	Effect.gen(function* () {
		const backend = yield* Backend
		const bots = yield* Bots
		const services = yield* Effect.context<AuthorizationServices>()
		// An app without models, such as a small test app, has no Live mode.
		const registry = yield* Effect.serviceOption(ModelRegistry)
		const sessions = yield* Effect.serviceOption(LiveSessions)
		const chatsOf = (caller: typeof Identity.Service) =>
			backend
				.forCaller(caller)
				.pipe(Effect.mapError(() => ChatStorageUnavailable.make({})))
		return handlers
			.handle("createLiveChat", ({ params, payload }) =>
				Effect.gen(function* () {
					const caller = yield* Identity
					if (Option.isNone(registry))
						return yield* LiveApi.LiveUnavailable.make({
							message: "This OpenBot has no Live mode.",
						})
					// Work for a Bot needs the delegate permission on it.
					const bot = yield* bots
						.access(caller, params.botId, "delegate")
						.pipe(Effect.provideContext(services))
					if (bot.archived)
						return yield* BotsApi.BotInvalid.make({
							message: "An archived Bot does no new work.",
						})
					const first = (yield* registry.value
						.liveCatalog(caller.organizationId)
						.pipe(
							Effect.mapError((error) =>
								LiveApi.LiveUnavailable.make({ message: error.message }),
							),
						)).models[0]
					const model =
						payload.model ??
						(first === undefined
							? undefined
							: Config.Selection.make({
									provider: first.provider,
									model: first.id,
								}))
					if (model === undefined)
						return yield* LiveApi.LiveUnavailable.make({
							message: "The organization has no Live model.",
						})
					yield* check(caller, {
						action: "use",
						resource: Authorization.Model.make({
							organizationId: caller.organizationId,
							provider: model.provider,
							id: model.model,
						}),
					}).pipe(Effect.provideContext(services))
					const chats = yield* chatsOf(caller)
					return yield* chats.create({
						bot,
						kind: "live",
						chain: chainFor(caller, bot),
						model,
					})
				}),
			)
			.handleRaw("connectLive", ({ params, query, request }) =>
				Effect.gen(function* () {
					const caller = yield* Identity
					if (Option.isNone(registry) || Option.isNone(sessions))
						return yield* LiveApi.LiveUnavailable.make({
							message: "This OpenBot has no Live mode.",
						})
					const chats = yield* chatsOf(caller)
					// The Chat must be a live Chat of the caller. Its model is the Live model.
					const view = yield* chats.get(params.chatId)
					const selection = view.chat.settings.model
					if (view.chat.kind !== "live" || selection === undefined)
						return yield* LiveApi.LiveUnavailable.make({
							message: "Only a live Chat has a Live session.",
						})
					const live = yield* registry.value
						.resolveLive(caller.organizationId, selection)
						.pipe(
							Effect.mapError((error) =>
								LiveApi.LiveUnavailable.make({ message: error.message }),
							),
						)
					const chosen = LiveSession.plan(live.model.capabilities, query)
					if (Result.isFailure(chosen))
						return yield* LiveApi.LiveUnavailable.make({
							message: chosen.failure,
						})
					const socket = yield* request.upgrade.pipe(
						Effect.mapError(() =>
							LiveApi.LiveUnavailable.make({
								message: "Open this address as a WebSocket.",
							}),
						),
					)
					yield* LiveSession.run({
						socket,
						chats,
						chat: params.chatId,
						author: ChatHost.authorOf(caller.userId, caller.tokenId),
						live,
						plan: chosen.success,
					}).pipe(
						Effect.provideService(LiveSessions, sessions.value),
						Effect.catchCause((cause) =>
							Effect.logWarning("A Live session ended with an error.", cause),
						),
					)
					return HttpServerResponse.empty()
				}),
			)
	}),
)
