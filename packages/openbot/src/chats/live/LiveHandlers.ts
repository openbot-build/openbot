import {
	Authorization,
	BotsApi,
	ChatStorageUnavailable,
	Identity,
	LiveApi,
	OpenBotApi,
} from "@openbot-build/api"
import { Config, Live } from "@openbot-build/core"
import { Effect, Result } from "effect"
import { HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { Backend } from "../../app/Backend.ts"
import * as Background from "../../app/Background.ts"
import * as Failures from "../../app/Failures.ts"
import * as Check from "../../authorization/Check.ts"
import { Bots } from "../../bots/Bots.ts"
import { ModelRegistry } from "../../models/ModelRegistry.ts"
import * as ChatHost from "../ChatHost.ts"
import { chainFor } from "../ChatHandlers.ts"
import * as LiveSession from "./LiveSession.ts"
import { LiveSessions } from "./LiveSessions.ts"
import { Files } from "../../files/Files.ts"
import * as ModelFiles from "../../files/ModelFiles.ts"

export const layer = HttpApiBuilder.group(OpenBotApi, "live", (handlers) =>
	Effect.gen(function* () {
		const backend = yield* Backend
		const bots = yield* Bots
		const { check } = yield* Check.make
		const registry = yield* ModelRegistry
		const sessions = yield* LiveSessions
		const files = yield* Files
		const chatsOf = (caller: typeof Identity.Service) =>
			backend
				.forCaller(caller)
				.pipe(
					Failures.replace(
						"OpenBot could not open the Chats of a member.",
						() => ChatStorageUnavailable.make({}),
					),
				)
		return handlers
			.handle("createLiveChat", ({ params, payload }) =>
				Effect.gen(function* () {
					const caller = yield* Identity
					// Work for a Bot needs the delegate permission on it.
					const bot = yield* bots.access(caller, params.botId, "delegate")
					if (bot.archived)
						return yield* BotsApi.BotInvalid.make({
							message: "An archived Bot does no new work.",
						})
					const first = (yield* registry
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
					})
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
					const chats = yield* chatsOf(caller)
					// The Chat must be a live Chat of the caller. Its model is the Live model.
					const view = yield* chats.get(params.chatId)
					const selection = view.chat.settings.model
					if (view.chat.execution.mode !== "live" || selection === undefined)
						return yield* LiveApi.LiveUnavailable.make({
							message:
								"Select Live execution before opening a Live connection.",
						})
					const live = yield* registry
						.resolveLive(caller.organizationId, selection)
						.pipe(
							Effect.mapError((error) =>
								LiveApi.LiveUnavailable.make({ message: error.message }),
							),
						)
					yield* check(caller, {
						action: "use",
						resource: Authorization.Model.make({
							organizationId: caller.organizationId,
							provider: selection.provider,
							id: selection.model,
						}),
					})
					const chosen = LiveSession.plan(live.model.capabilities, query)
					if (Result.isFailure(chosen))
						return yield* LiveApi.LiveUnavailable.make({
							message: chosen.failure,
						})
					// A request that is not a WebSocket is a mistake of the client.
					const socket = yield* request.upgrade.pipe(
						Effect.catch((error) =>
							Effect.logDebug(
								"A request to a Live session was not a WebSocket.",
								error,
							).pipe(
								Effect.andThen(
									LiveApi.LiveUnavailable.make({
										message: "Open this address as a WebSocket.",
									}),
								),
							),
						),
					)
					yield* LiveSession.run({
						socket,
						chats,
						chat: params.chatId,
						author: ChatHost.authorOf(caller.userId, caller.tokenId),
						live,
						plan: chosen.success,
						generation: view.chat.execution.generation,
						prepareContext: (prompt) =>
							ModelFiles.context(files, caller, prompt).pipe(
								Effect.mapError((error) =>
									Live.LiveError.make({
										reason: "unsupported",
										message: error.message,
									}),
								),
							),
						storeImage: (mediaType, bytes) =>
							Effect.gen(function* () {
								const file = yield* files.uploadBytes(caller, {
									fileName:
										mediaType === "image/png"
											? "live-image.png"
											: "live-image.jpg",
									mediaType,
									bytes,
								})
								return yield* files.prompt(caller, [
									{
										type: "message",
										role: "user",
										content: [{ type: "input_image", file_id: file.id }],
									},
								])
							}).pipe(
								Failures.replace("OpenBot could not store a Live image.", () =>
									Live.LiveError.make({
										reason: "unsupported",
										message: "OpenBot could not save this image.",
									}),
								),
							),
					}).pipe(
						Effect.provideService(LiveSessions, sessions),
						Background.logFailure("A Live session ended with an error."),
					)
					return HttpServerResponse.empty()
				}),
			)
	}),
)
