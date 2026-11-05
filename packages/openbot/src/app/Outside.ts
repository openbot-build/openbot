/**
 * The services from outside of OpenBot: the drivers of the Computer providers,
 * the Live backends, the readers of the password managers, the network and the
 * check of Apps, the DNS check of domains, the public network of the App
 * Index, and the discovery of Apps. `layer` gives the real ones. A test or the
 * development server gives other ones.
 */
import { NodeWS } from "@effect/platform-node"
import type { Discovery, Network } from "@openbot-build/protocol"
import { Effect, Layer } from "effect"
import type { HttpClient } from "effect/http"
import * as OpenAiRealtime from "@openbot-build/model-providers/providers/openai/OpenAiRealtime"
import * as LiveBackends from "@openbot-build/models-contract/models/LiveBackends"
import * as AppHost from "@openbot-build/plugin-apps/AppHost"
import * as AppDiscovery from "@openbot-build/plugin-apps/Discovery"
import * as AppProbe from "@openbot-build/plugin-apps/Probe"
import * as Drivers from "@openbot-build/plugin-computers/Drivers"
import * as VaultReaders from "@openbot-build/plugin-vaults/Readers"
import * as DomainControl from "@openbot-build/server-kernel/apps/DomainControl"
import type * as ErrorRecords from "@openbot-build/server-kernel/errors/Records"
import * as OutboundPolicy from "@openbot-build/server-kernel/network/OutboundPolicy"

/** The services from outside of OpenBot that the host needs. */
export type Services =
	| Drivers.Drivers
	| LiveBackends.LiveBackends
	| VaultReaders.Readers
	| AppProbe.Probe
	| AppHost.AppNetwork
	| DomainControl.DomainControl
	| Network.PublicNetwork
	| Discovery.Discovery

/** The Live backends of a real server. The `ws` package can send the key in a header. */
export const layerLiveBackends = Layer.unwrap(
	Effect.map(OpenAiRealtime.backend, (openai) => LiveBackends.layer([openai])),
).pipe(Layer.provide(NodeWS.layerWebSocketConstructor))

/**
 * The real services from outside of OpenBot. They use the network of the
 * process, with the address rule of the outbound guard.
 */
export const layer: Layer.Layer<
	Services,
	never,
	HttpClient.HttpClient | ErrorRecords.Records
> = Layer.mergeAll(
	Drivers.layer,
	layerLiveBackends,
	VaultReaders.layer,
	AppProbe.layer,
	AppHost.layerNetwork,
	DomainControl.layer,
	OutboundPolicy.layerPublicNetwork,
	AppDiscovery.layerPublic,
)
