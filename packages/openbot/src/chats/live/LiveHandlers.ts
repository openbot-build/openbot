import { LiveApi, OpenBotApi } from "@openbot-build/api"
import { Turn } from "@openbot-build/core"
import { Identity } from "@openbot-build/domain"
import { Cause, Effect, Result } from "effect"
import { HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import * as Background from "../../execution/Background.ts"
import * as Failures from "../../errors/Failures.ts"
import * as Report from "../../errors/Report.ts"
import { ModelRegistry } from "../../models/ModelRegistry.ts"
import * as ChatHost from "../ChatHost.ts"
import * as ChatCommands from "../ChatCommands.ts"
import * as ChatQueries from "../ChatQueries.ts"
import * as ChatViews from "../ChatViews.ts"
import * as ChatErrors from "../ChatErrors.ts"
import * as LiveSession from "./LiveSession.ts"

export const layer = HttpApiBuilder.group(OpenBotApi, "live", (handlers) =>
	Effect.gen(function* () {
		const background = yield* Background.make
		const report = yield* Report.make
		const commands = yield* ChatCommands.make
		const queries = yield* ChatQueries.make
		const registry = yield* ModelRegistry
		const sessions = yield* LiveSession.make
		return handlers
			.handle("createLiveChat", ({ params, payload }) =>
				Effect.gen(function* () {
					const caller = yield* Identity
					const view = yield* commands.createLive(
						caller,
						params.botId,
						payload.model,
					)
					return ChatViews.project(yield* queries.describe(caller, view))
				}).pipe(
					ChatErrors.map,
					Effect.catchTag("ChatModelInvalid", (error) =>
						Effect.fail(
							LiveApi.LiveUnavailable.make({ message: error.message }),
						),
					),
				),
			)
			.handleRaw("connectLive", ({ params, query, request }) =>
				Effect.gen(function* () {
					const caller = yield* Identity
					// The Chat must be a live Chat of the caller. Its model is the Live model.
					const view = yield* queries
						.read(caller, params.chatId)
						.pipe(ChatErrors.map)
					const selection =
						view.chat.turn !== undefined &&
						!Turn.isTerminal(view.chat.turn.status)
							? view.chat.turn.settings.model
							: view.chat.settings.model
					if (
						ChatHost.hostState(view.chat).kind !== "live" ||
						selection === undefined
					)
						return yield* LiveApi.LiveUnavailable.make({
							message: "Only a live Chat has a Live session.",
						})
					const live = yield* registry
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
					// A request that is not a WebSocket is a mistake of the client.
					const socket = yield* request.upgrade.pipe(
						Effect.tapCause((cause) =>
							Cause.hasInterruptsOnly(cause)
								? Effect.void
								: report("live.upgrade", cause),
						),
						Failures.replace("live.upgrade", () =>
							LiveApi.LiveUnavailable.make({
								message: "Open this address as a WebSocket.",
							}),
						),
					)
					yield* sessions
						.run({
							socket,
							chat: params.chatId,
							identity: {
								owner: caller,
								actor: caller,
								botId: ChatHost.hostState(view.chat).bot,
							},
							selection,
							live,
							plan: chosen.success,
						})
						.pipe(background.logFailure("A Live session ended with an error."))
					return HttpServerResponse.empty()
				}),
			)
	}),
)
