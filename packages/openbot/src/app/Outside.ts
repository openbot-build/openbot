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
import * as OpenAiRealtime from "../model-providers/providers/openai/OpenAiRealtime.ts"
import * as LiveBackends from "../models-contract/models/LiveBackends.ts"
import * as AppHost from "../plugin-apps/AppHost.ts"
import * as AppDiscovery from "../plugin-apps/Discovery.ts"
import * as AppProbe from "../plugin-apps/Probe.ts"
import * as Drivers from "../plugin-computers/Drivers.ts"
import * as VaultReaders from "../plugin-vaults/Readers.ts"
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
