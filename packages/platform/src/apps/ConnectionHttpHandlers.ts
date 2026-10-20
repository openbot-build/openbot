import { PlatformApi } from "@openbot-build/platform-api"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Connections } from "./Connections.ts"
import { Lifecycle } from "./Lifecycle.ts"

export const layer = HttpApiBuilder.group(
	PlatformApi,
	"connections",
	(handlers) =>
		Effect.gen(function* () {
			const connections = yield* Connections
			const lifecycle = yield* Lifecycle
			return handlers
				.handle("verifyConnection", ({ params }) =>
					lifecycle.verify(params.connectionId),
				)
				.handle("refreshConnectionAuthorization", ({ params }) =>
					lifecycle.refresh(params.connectionId),
				)
				.handle("revalidateConnection", ({ params, payload }) =>
					lifecycle.revalidate(params.connectionId, payload),
				)
				.handle("listConnections", () => connections.listConnections)
				.handle("createManualConnection", ({ payload }) =>
					connections.createManualConnection(payload),
				)
				.handle("updateManualConnection", ({ params, payload }) =>
					lifecycle.updateManual(params.connectionId, payload),
				)
				.handle("prepareConnection", ({ payload }) =>
					connections.prepareConnection(payload.input),
				)
				.handle("getConnectionDraft", ({ params }) =>
					connections.getConnectionDraft(params.draftId),
				)
				.handle("getConnection", ({ params }) =>
					connections.getConnection(params.connectionId),
				)
				.handle("createConnection", ({ payload }) =>
					connections.createConnection(payload),
				)
				.handle("updateConnection", ({ params, payload }) =>
					lifecycle.update(params.connectionId, payload),
				)
				.handle("deleteConnection", ({ params }) =>
					lifecycle.remove(params.connectionId),
				)
		}),
)
