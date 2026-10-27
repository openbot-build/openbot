import { OpenBotApi } from "@openbot-build/api"

import { Identity } from "@openbot-build/domain"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import * as HttpErrors from "../execution/HttpErrors.ts"
import { Views } from "./Views.ts"
export const layer = HttpApiBuilder.group(OpenBotApi, "appViews", (handlers) =>
	Effect.gen(function* () {
		const views = yield* Views
		const safe = yield* HttpErrors.make
		return handlers
			.handle("open", ({ params, payload }) =>
				Effect.flatMap(Identity, (identity) =>
					views.open(
						identity,
						params.operationId,
						payload.chatId,
						payload.itemId,
					),
				).pipe(safe),
			)
			.handle("get", ({ params }) =>
				Effect.flatMap(Identity, (identity) =>
					views.get(identity, params.viewId),
				).pipe(safe),
			)
			.handle("close", ({ params }) =>
				Effect.flatMap(Identity, (identity) =>
					views.close(identity, params.viewId),
				).pipe(safe),
			)
			.handle("read", ({ params, payload }) =>
				Effect.flatMap(Identity, (identity) =>
					views.read(identity, params.viewId, payload.method, payload.params),
				).pipe(safe),
			)
			.handle("act", ({ params, payload }) =>
				Effect.flatMap(Identity, (identity) =>
					views.act(identity, params.viewId, payload),
				).pipe(safe),
			)
			.handle("confirmContext", ({ params, payload }) =>
				Effect.flatMap(Identity, (identity) =>
					views.confirmContext(
						identity,
						params.viewId,
						payload.revision,
						payload.context,
					),
				).pipe(safe),
			)
			.handle("interaction", ({ params, query }) =>
				Effect.flatMap(Identity, (identity) =>
					views.interaction(identity, params.operationId, query.chatId),
				).pipe(safe),
			)
			.handle("message", ({ params, payload }) =>
				Effect.flatMap(Identity, (identity) =>
					views.message(
						identity,
						params.viewId,
						payload.content,
						payload.commandKey,
					),
				).pipe(safe),
			)
	}),
)
