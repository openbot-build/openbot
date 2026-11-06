/**
 * The real services from outside of OpenBot that the Apps plugin needs: the
 * check of App connections, the network of the Apps of members, and the
 * discovery of Apps. The host gives them; a test gives its own.
 */
import { AppConnections as Domain } from "@openbot-build/domain"

import {
	AppConnections,
	McpClient,
	Store,
	Client,
	Network,
	CatalogDiscovery,
	Discovery,
} from "@openbot-build/protocol"
import * as NodeHttpServer from "@openbot-build/protocol/NodeHttpServer"
import { AppNetwork } from "@openbot-build/apps-contract/apps/AppNetwork"
import { Probe } from "@openbot-build/apps-contract/apps/Probe"
import * as OutboundPolicy from "@openbot-build/server-kernel/OutboundPolicy"
import * as Failures from "@openbot-build/server-kernel/Failures"
import { Effect, Layer, Option } from "effect"

/** A scoped discovery handshake decides the protection. It calls no business tool. */
export const layerProbeWith = (
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
/** The real check of App connections. It uses the network of the process. */
export const layerProbe = Layer.unwrap(
	Effect.gen(function* () {
		const policy = yield* OutboundPolicy.OutboundPolicy
		return layerProbeWith((connection) =>
			NodeHttpServer.layerUserNetwork({
				owner: connection.owner,
				allowedOrigins: [new URL(connection.endpoint).origin],
				allowAddress: policy.allowAddress,
			}),
		)
	}),
)

/** The real network of the Apps of members. It keeps the address rule of the outbound guard. */
export const layerNetwork = Layer.effect(
	AppNetwork,
	Effect.gen(function* () {
		const policy = yield* OutboundPolicy.OutboundPolicy
		return {
			layer: (owner: string, origins: ReadonlyArray<string>) =>
				NodeHttpServer.layerUserNetwork({
					owner,
					allowedOrigins: origins,
					allowAddress: policy.allowAddress,
				}),
		}
	}),
)

/** Discovery is anonymous. OpenBot credentials are never sent as publisher headers. */
export const layerDiscovery: Layer.Layer<Discovery.Discovery> =
	CatalogDiscovery.layer().pipe(
		Layer.provide(CatalogDiscovery.layerRules),
		Layer.provide(OutboundPolicy.layerPublicNetwork),
	)

/** Every real outside service of the Apps plugin. */
export const layer = Layer.mergeAll(layerProbe, layerNetwork, layerDiscovery)
