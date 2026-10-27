import { ConnectionsApi as Api } from "@openbot-build/api"
import {
	AppConnections,
	McpClient,
	MemoryStore,
	Store,
	Network,
} from "@openbot-build/protocol"
import * as NodeHttpServer from "@openbot-build/protocol/NodeHttpServer"
import { OutboundPolicy } from "../network/OutboundPolicy.ts"
import * as Failures from "../app/Failures.ts"
import { Context, Effect, Layer } from "effect"

export class Probe extends Context.Service<
	Probe,
	{
		readonly check: (input: {
			readonly app: Store.AppRecord
			readonly connection: Store.UserConnection
		}) => Effect.Effect<
			| { readonly requiresAuthorization: false }
			| {
					readonly requiresAuthorization: true
					readonly scopes: ReadonlyArray<string>
					readonly resourceMetadataUrl?: string
			  },
			Api.ConnectionConfigurationInvalid
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
					const store = yield* Store.AppStore
					yield* store.save(input)
					yield* McpClient.open({
						key: input.connection,
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
				// @effect-diagnostics-next-line strictEffectProvide:off -- Each check builds its own short-lived store and network for one handshake.
				Effect.provide(
					Layer.mergeAll(
						MemoryStore.layer,
						MemoryStore.layerCredentials,
						AppConnections.layerConnectionScopes,
						McpClient.layerPolicy(() => Effect.void),
						network(input.connection),
					),
				),
				Failures.replace("App connection check failed", () =>
					Api.ConnectionConfigurationInvalid.make({
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
