/**
 * The services from outside of OpenBot: the drivers of the Computer providers,
 * the Live backends, the readers of the password managers, the network and the
 * check of Apps, the DNS check of domains, the public network of the App
 * Index, the discovery of Apps, and the mail transport. `layer` gives the
 * real ones. A test or the development server gives other ones over them. The
 * models that the program gives itself (`BuiltinModels`) come from outside
 * too. They are a reference with no models by default, so they are not in
 * `Host.Outside`.
 */
import { NodeWS } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import type { HttpClient } from "effect/http"
import * as OpenAiRealtime from "@openbot-build/model-providers/OpenAiRealtime"
import * as LiveBackends from "@openbot-build/models-contract/LiveBackends"
import * as AppsOutside from "@openbot-build/plugin-apps/Outside"
import * as ComputersOutside from "@openbot-build/plugin-computers/Outside"
import * as MailOutside from "@openbot-build/plugin-mail/Outside"
import * as VaultsOutside from "@openbot-build/plugin-vaults/Outside"
import * as DomainControl from "@openbot-build/server-kernel/DomainControl"
import type * as ErrorRecords from "@openbot-build/server-kernel/Records"
import * as OutboundPolicy from "@openbot-build/server-kernel/OutboundPolicy"
import type { Outside } from "./Host.ts"

/** The Live backends of a real server. The `ws` package can send the key in a header. */
export const layerLiveBackends = Layer.unwrap(
	Effect.map(OpenAiRealtime.backend, (openai) => LiveBackends.layer([openai])),
).pipe(Layer.provide(NodeWS.layerWebSocketConstructor))

/**
 * The real services from outside of OpenBot. They use the network of the
 * process, with the address rule of the outbound guard. Mail goes out with
 * SMTP.
 */
export const layer: Layer.Layer<
	Outside,
	never,
	HttpClient.HttpClient | ErrorRecords.Records
> = Layer.mergeAll(
	ComputersOutside.layer,
	layerLiveBackends,
	VaultsOutside.layer,
	AppsOutside.layer,
	DomainControl.layer,
	OutboundPolicy.layerPublicNetwork,
	MailOutside.layer,
)
