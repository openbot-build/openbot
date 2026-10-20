import { Identity, PlatformApi } from "@openbot-build/platform-api"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Views } from "./Views.ts"
export const layer = HttpApiBuilder.group(PlatformApi, "appViews", (handlers) =>
	Effect.gen(function* () {
		const views = yield* Views
		return handlers
			.handle("open", ({ params, payload }) =>
				Effect.flatMap(Identity, (identity) =>
					views.open(
						identity,
						params.operationId,
						payload.sessionId,
						payload.itemId,
						payload.version,
					),
				),
			)
			.handle("get", ({ params }) =>
				Effect.flatMap(Identity, (identity) =>
					views.get(identity, params.viewId),
				),
			)
			.handle("close", ({ params }) =>
				Effect.flatMap(Identity, (identity) =>
					views.close(identity, params.viewId),
				),
			)
			.handle("read", ({ params, payload }) =>
				Effect.flatMap(Identity, (identity) =>
					views.read(identity, params.viewId, payload.method, payload.params),
				),
			)
			.handle("act", ({ params, payload }) =>
				Effect.flatMap(Identity, (identity) =>
					views.act(identity, params.viewId, payload),
				),
			)
			.handle("operation", ({ params }) =>
				Effect.flatMap(Identity, (identity) =>
					views.operation(identity, params.viewId, params.requestId),
				),
			)
			.handle("confirmContext", ({ params, payload }) =>
				Effect.flatMap(Identity, (identity) =>
					views.confirmContext(
						identity,
						params.viewId,
						payload.revision,
						payload.context,
					),
				),
			)
			.handle("interaction", ({ params, query }) =>
				Effect.flatMap(Identity, (identity) =>
					views.interaction(identity, params.operationId, query.sessionId),
				),
			)
			.handle("message", ({ params, payload }) =>
				Effect.flatMap(Identity, (identity) =>
					views.message(identity, params.viewId, payload.content),
				),
			)
	}),
)
