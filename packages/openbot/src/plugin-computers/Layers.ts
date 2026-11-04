import { Layer } from "effect"
import * as ComputerProviders from "./ComputerProviders.ts"
import * as Computers from "./Computers.ts"
import * as Connectors from "./connector/Connectors.ts"
import * as Lifecycle from "./Lifecycle.ts"
import * as Pairings from "./Pairings.ts"
import * as Sessions from "./Sessions.ts"

/**
 * Computers, their providers, pairings and command sessions. The static
 * assembly and the computers plugin both use it.
 */
export const layerComputers = Sessions.layer.pipe(
	Layer.provideMerge(Pairings.layer),
	Layer.provideMerge(Computers.layer),
	Layer.provideMerge(Lifecycle.layer),
	Layer.provideMerge(Connectors.layer),
	Layer.provideMerge(ComputerProviders.layer),
)
