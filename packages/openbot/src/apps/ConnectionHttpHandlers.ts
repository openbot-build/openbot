import { Identity } from "@openbot-build/domain"
import { AuthorizationCommands } from "./AuthorizationCommands.ts"
import * as HttpErrors from "../execution/HttpErrors.ts"
import { OpenBotApi, ConnectionsApi } from "@openbot-build/api"

import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Connections } from "./Connections.ts"
import { ConnectionCommands } from "./ConnectionCommands.ts"

export const layer = HttpApiBuilder.group(
	OpenBotApi,
	"connections",
	(handlers) =>
		Effect.gen(function* () {
			const connections = yield* Connections
			const lifecycle = yield* ConnectionCommands
			const authorization = yield* AuthorizationCommands
			const safe = yield* HttpErrors.make
			return handlers
				.handle("getConnectionExecution", ({ params }) =>
					Effect.flatMap(Identity, (actor) =>
						lifecycle
							.get(actor, params.connectionId, params.executionId)
							.pipe(Effect.map(ConnectionsApi.ConnectionExecution.make)),
					).pipe(safe),
				)
				.handle("verifyConnection", ({ params, payload }) =>
					Effect.flatMap(Identity, (actor) =>
						lifecycle.start(
							actor,
							params.connectionId,
							{ _tag: "Verify" },
							payload.commandKey,
						),
					).pipe(safe),
				)
				.handle("refreshConnectionAuthorization", ({ params, payload }) =>
					Effect.flatMap(Identity, (actor) =>
						authorization.start(
							actor,
							{ kind: "Refresh", connectionId: params.connectionId },
							payload.commandKey,
						),
					).pipe(safe),
				)
				.handle("revalidateConnection", ({ params, payload }) =>
					Effect.flatMap(Identity, (actor) =>
						lifecycle.start(
							actor,
							params.connectionId,
							{
								_tag: "Revalidate",
								request: {
									revision: payload.revision,
									draftId: payload.draftId,
									remoteIndex: payload.remoteIndex,
									values: payload.values,
									confirmed: payload.confirmed,
								},
							},
							payload.commandKey,
						),
					).pipe(safe),
				)
				.handle("listConnections", () => connections.listConnections)
				.handle("createManualConnection", ({ payload }) =>
					connections.createManualConnection(payload),
				)
				.handle("updateManualConnection", ({ params, payload }) =>
					Effect.flatMap(Identity, (actor) =>
						lifecycle.start(
							actor,
							params.connectionId,
							{
								_tag: "Manual",
								request: {
									revision: payload.revision,
									name: payload.name,
									url: payload.url,
									transport: payload.transport,
									headers: payload.headers,
								},
							},
							payload.commandKey,
						),
					).pipe(safe),
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
					Effect.flatMap(Identity, (actor) =>
						lifecycle.start(
							actor,
							params.connectionId,
							{
								_tag: "Update",
								request: {
									revision: payload.revision,
									name: payload.name,
									enabled: payload.enabled,
								},
							},
							payload.commandKey,
						),
					).pipe(safe),
				)
				.handle("deleteConnection", ({ params, payload }) =>
					Effect.flatMap(Identity, (actor) =>
						authorization.start(
							actor,
							{ kind: "Remove", connectionId: params.connectionId },
							payload.commandKey,
						),
					).pipe(safe),
				)
		}),
)
