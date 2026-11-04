import { Layer } from "effect"
import * as ChannelInbox from "./ChannelInbox.ts"
import * as ChannelQueue from "./ChannelQueue.ts"
import * as ChannelRegistry from "./ChannelRegistry.ts"
import * as Channels from "./Channels.ts"
import * as ChannelWatch from "./ChannelWatch.ts"

/**
 * Channels and their connections. A custom Channel calls an address that an
 * administrator chose, so it uses the network of Apps. The static assembly
 * and the channels plugin both use it.
 */
export const layerChannels = ChannelRegistry.layer.pipe(
	Layer.provideMerge(ChannelQueue.layer),
	Layer.provideMerge(Layer.merge(ChannelInbox.layer, ChannelWatch.layer)),
	Layer.provideMerge(Channels.layer),
)
