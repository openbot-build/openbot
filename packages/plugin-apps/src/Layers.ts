/**
 * The compositions of the App services. The apps plugin uses them.
 */
import {
	CatalogDiscovery,
	PublicIndexing,
	RobotsPolicy,
} from "@openbot-build/protocol"
import { Effect, Layer } from "effect"
import { instanceNamespace } from "@openbot-build/apps-contract/apps/DeveloperRows"
import * as ActionPolicy from "./ActionPolicy.ts"
import * as AppHost from "./AppHost.ts"
import * as AuthorizationCommands from "./AuthorizationCommands.ts"
import * as Authorizations from "./Authorizations.ts"
import * as ConnectionCommands from "./ConnectionCommands.ts"
import * as Connections from "./Connections.ts"
import * as ConnectionSessions from "./ConnectionSessions.ts"
import * as GrantCleanup from "./GrantCleanup.ts"
import * as AppIndex from "./AppIndex.ts"
import * as IndexStore from "./IndexStore.ts"
import * as IndexWork from "./IndexWork.ts"
import * as Lifecycle from "./Lifecycle.ts"
import * as ProtocolStores from "./ProtocolStores.ts"

/**
 * App connections and authorization. The workflows of Apps come later. It
 * needs `ConnectionScopes`, which the host gives.
 */
export const layerApps = Layer.mergeAll(
	Lifecycle.layer,
	Authorizations.layer,
).pipe(
	Layer.provideMerge(Connections.layer),
	Layer.provideMerge(ConnectionSessions.layer),
	Layer.provideMerge(AuthorizationCommands.layer),
	Layer.provideMerge(ConnectionCommands.layer),
	Layer.provideMerge(GrantCleanup.layer),
	Layer.provideMerge(AppHost.layer),
	Layer.provide(CatalogDiscovery.layerRules),
	Layer.provide(Layer.merge(ProtocolStores.layer, ActionPolicy.layer)),
)

/**
 * The App Index, the work that reads App Catalogs into it, and its store. It
 * reads the timing of its work from the config of the plugin (`Timing`), and
 * its namespace from the instance settings (`instanceNamespace`).
 */
export const layerIndex = Layer.unwrap(
	Effect.gen(function* () {
		const options = (yield* IndexWork.Timing) ?? {}
		const namespace = yield* instanceNamespace
		const indexing = PublicIndexing.layerInspection.pipe(
			Layer.provide(CatalogDiscovery.layerRules),
			Layer.provide(RobotsPolicy.layer),
		)
		const work = IndexWork.layer(options).pipe(Layer.provide(indexing))
		return Layer.merge(
			AppIndex.layer({ simulated: namespace === "development" }),
			work,
		).pipe(Layer.provideMerge(IndexStore.layer))
	}),
)
