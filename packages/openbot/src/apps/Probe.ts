import { AppConnections as Domain } from "@openbot-build/domain"

import {
	AppConnections,
	McpClient,
	Store,
	Client,
	Network,
} from "@openbot-build/protocol"
import * as NodeHttpServer from "@openbot-build/protocol/NodeHttpServer"
import { OutboundPolicy } from "../network/OutboundPolicy.ts"
import * as Failures from "../errors/Failures.ts"
import { Context, Effect, Layer, Option } from "effect"

export class Probe extends Context.Service<
	Probe,
	{
		readonly check: (input: {
			readonly connection: Store.UserConnection
		}) => Effect.Effect<
			| { readonly requiresAuthorization: false }
			| {
					readonly requiresAuthorization: true
					readonly scopes: ReadonlyArray<string>
					readonly resourceMetadataUrl?: string
			  },
			Domain.ConnectionConfigurationInvalid
		>
	}
>()("@openbot-build/openbot/apps/Probe") {}

/** A scoped discovery handshake decides the protection. It calls no business tool. */
export const layerWithNetwork = (
	network: (connection: Store.UserConnection) => Layer.Layer<Network.Network>,
) =>
	Layer.succeed(Probe, {
		check: (input) =>
			Effect.scoped(
				Effect.gen(function* () {
					yield* McpClient.open({
						key: input.connection,
						endpoint: input.connection.endpoint,
						headers: input.connection.headers,
						readToken: AppConnections.authorizationToken(
							input.connection,
							Option.none(),
						),
						check: (request) =>
							request.action === "connect"
								? Effect.void
								: Effect.fail(
										Client.PermissionDenied.make({
											action: request.action,
											target: request.target,
										}),
									),
						clientInfo: { name: "OpenBot", version: "0.1.0" },
					})
					return { requiresAuthorization: false } as const
				}),
			).pipe(
				Effect.catchTag("AuthorizationRequired", (error) =>
					Effect.succeed({
						requiresAuthorization: true,
						scopes: error.scopes,
						...(error.resourceMetadataUrl === undefined
							? {}
							: { resourceMetadataUrl: error.resourceMetadataUrl }),
					} as const),
				),
				// @effect-diagnostics-next-line strictEffectProvide:off -- Each check builds its own network for one handshake.
				Effect.provide(network(input.connection)),
				Failures.replace("App connection check failed", () =>
					Domain.ConnectionConfigurationInvalid.make({
						message:
							"The App connection could not be checked. Check its address and required configuration, then try again.",
						keys: [],
					}),
				),
			),
	})
export const layer = Layer.unwrap(
	Effect.gen(function* () {
		const policy = yield* OutboundPolicy
		return layerWithNetwork((connection) =>
			NodeHttpServer.layerUserNetwork({
				owner: connection.owner,
				allowedOrigins: [new URL(connection.endpoint).origin],
				allowAddress: policy.allowAddress,
			}),
		)
	}),
)
